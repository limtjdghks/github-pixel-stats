import type { BatchResult } from "../data/checkpoint-model.js";
import { readAdmissions, updateAdmissions, type Admissions } from "../storage/admissions.js";
import type { ObjectEntry, ObjectStore } from "../storage/object-store.js";
import { countOperations, emptyOperationCount, type BlobOperationCount } from "../storage/operation-count.js";
import { CHECKPOINT_PREFIX, MANIFEST_PREFIX, userKeyFromPathname } from "../storage/pathnames.js";
import { readUsage, removeExpiredUsage, updateUsage } from "../storage/usage.js";
import { clearAdmissionFailures, markAdmissionFailures } from "./admission-policy.js";
import { boundedDeadline } from "./invocation-deadline.js";
import { logError } from "./log.js";
import { PUBLISH_RESERVE_MS, runRefreshJob, type RefreshDependencies } from "./refresh-job.js";
import { selectDueUsers } from "./refresh-policy.js";
import {
  addCronUsage,
  cronAdvancedAllowance,
  DAILY_ADVANCED_BUDGET,
  JOB_ADVANCED_ESTIMATE,
  USAGE_RECORD_OPERATIONS,
  USAGE_RETENTION_DAYS,
  USAGE_SWEEP_DAYS,
} from "./usage-policy.js";

/** Cron 한 번의 전체 시간 예산입니다. `vercel.json`의 cron `maxDuration`(300초)보다 짧아야 합니다. */
export const CRON_BUDGET_MS = 280_000;
const CRON_DEADLINE_MARGIN_MS = 10_000;
/** 한 실행의 GitHub 요청 상한입니다. token의 시간당 한도(5,000회) 안에서 bootstrap 몫을 남겨 둡니다. */
export const CRON_MAX_REQUESTS = 1_000;
/** 한 사용자가 독점할 수 있는 시간입니다. 남은 사용자는 다음 실행에서 이어서 처리합니다. */
export const CRON_USER_BUDGET_MS = 60_000;
/** 발행 여유와 batch 한 번을 진행할 시간이 남지 않으면 다음 사용자를 시작하지 않습니다. */
export const CRON_MIN_USER_BUDGET_MS = PUBLISH_RESERVE_MS + 10_000;
/**
 * 등록 기록·사용량 기록 읽기·갱신 한 번의 시간 예산입니다. 갱신은 루프가 deadline 근처에서 끝난 뒤에도 실행되므로
 * 둘을 합친 시간이 deadline과 Function 종료 사이 여유(`CRON_DEADLINE_MARGIN_MS`)보다 짧아야 합니다.
 */
export const CRON_ADMISSIONS_TIMEOUT_MS = 4_000;
export const CRON_USAGE_TIMEOUT_MS = 4_000;

export interface CronLimits {
  deadline: Date;
  maxRequests: number;
  userBudgetMs: number;
  minUserBudgetMs: number;
}

export interface CronSummary {
  due: number;
  processed: number;
  published: number;
  requests: number;
  errors: number;
  statuses: Record<BatchResult["status"], number>;
  /** 루프를 끝낸 이유입니다. `complete` 외에는 남은 due 사용자를 다음 실행이 이어받습니다. */
  stopped: "complete" | "deadline" | "requests" | "rate-limit" | "blob-budget";
  blob: {
    /** 이번 실행이 쓴 Blob 작업 수입니다(사용량 기록 쓰기 포함). */
    operations: BlobOperationCount;
    /** 이번 실행을 더한, 실행을 시작한 날(UTC)의 Advanced Operation 합계입니다. 사용량 기록을 쓰지 못했으면 null입니다. */
    dailyAdvanced: number | null;
    dailyBudget: number;
  };
}

export function cronLimits(now: Date, invocationDeadline: Date | undefined): CronLimits {
  return {
    deadline: boundedDeadline(now, CRON_BUDGET_MS, invocationDeadline, CRON_DEADLINE_MARGIN_MS),
    maxRequests: CRON_MAX_REQUESTS,
    userBudgetMs: CRON_USER_BUDGET_MS,
    minUserBudgetMs: CRON_MIN_USER_BUDGET_MS,
  };
}

/**
 * due 사용자를 우선순위대로 하나씩 갱신합니다.
 * Cron 전달은 중복·누락·겹침이 있을 수 있으므로 매 실행은 목록에서 대상을 다시 고르고, 같은 사용자의 동시 실행은
 * checkpoint lease가 `busy`로 막습니다. 사용자 한 명의 오류는 집계만 하고 다음 사용자로 넘어갑니다.
 * 등록 기록은 시작할 때 읽어 실패 표시된 미발행 사용자를 뒤로 보내고, 루프가 끝나면 한 번의 쓰기로 정리합니다
 * (`reconcileAdmissions()`). 등록 기록 읽기·쓰기 실패는 오류로 집계하며 갱신 자체는 계속합니다.
 * 오늘의 사용량 기록을 시작할 때 읽어 Blob Advanced Operation 일일 예산의 남은 몫 안에서만 사용자를 시작하고, 끝나면
 * 이번 실행의 작업 수를 더합니다. 사용량 기록을 읽지 못하면 예산을 알 수 없으므로 갱신하지 않습니다(fail-closed).
 * 보존 기간이 지난 사용량 기록은 시작 직후 지웁니다.
 * 목록 조회 실패는 그대로 던집니다.
 */
export async function runCron(limits: CronLimits, dependencies: RefreshDependencies): Promise<CronSummary> {
  const store = dependencies.stores.privateStore;
  const startedAt = dependencies.now();
  const summary: CronSummary = {
    due: 0,
    processed: 0,
    published: 0,
    requests: 0,
    errors: 0,
    statuses: { paused: 0, busy: 0, conflict: 0, failed: 0, ready: 0 },
    stopped: "complete",
    blob: { operations: emptyOperationCount(), dailyAdvanced: null, dailyBudget: DAILY_ADVANCED_BUDGET },
  };
  // 사용량 기록 자체의 읽기·쓰기는 `USAGE_RECORD_OPERATIONS`로 따로 더하므로 집계 범위 밖에서 합니다.
  let allowance = 0;
  try {
    allowance = cronAdvancedAllowance((await readUsage(store, startedAt, AbortSignal.timeout(CRON_USAGE_TIMEOUT_MS))).usage);
  } catch (error) {
    summary.errors += 1;
    logError("cron.usage_read_failed", error);
  }
  // delete는 abort signal을 받지 않으므로 deadline 여유를 쓰지 않도록 시간이 넉넉한 시작 직후에 정리합니다.
  try {
    await removeExpiredUsage(store, startedAt, USAGE_RETENTION_DAYS, USAGE_SWEEP_DAYS);
  } catch (error) {
    summary.errors += 1;
    logError("cron.usage_cleanup_failed", error);
  }
  await countOperations(summary.blob.operations, () => refreshDueUsers(limits, dependencies, allowance, summary));
  await recordUsage(store, startedAt, summary);
  return summary;
}

/** 목록에서 due 사용자를 골라 예산 안에서 갱신하고 등록 기록을 정리하며, 결과를 `summary`에 더합니다. */
async function refreshDueUsers(
  limits: CronLimits,
  dependencies: RefreshDependencies,
  allowance: number,
  summary: CronSummary,
): Promise<void> {
  const store = dependencies.stores.privateStore;
  const operations = summary.blob.operations;
  // job이 오류로 끝나도 이미 보낸 GitHub 요청이 예산에 남도록 요청 자체를 셉니다.
  let requests = 0;
  const counted: RefreshDependencies = {
    ...dependencies,
    github: {
      requestPage(request, signal) {
        requests += 1;
        return dependencies.github.requestPage(request, signal);
      },
    },
  };
  const [checkpoints, manifests] = await Promise.all([store.list(CHECKPOINT_PREFIX), store.list(MANIFEST_PREFIX)]);
  let admissions: Admissions | null = null;
  try {
    admissions = (await readAdmissions(store, AbortSignal.timeout(CRON_ADMISSIONS_TIMEOUT_MS))).admissions;
  } catch (error) {
    summary.errors += 1;
    logError("cron.admissions_read_failed", error);
  }
  const deferred = new Set(admissions === null ? [] : Object.entries(admissions.users)
    .filter(([, admission]) => admission.failedAt !== null)
    .map(([key]) => key));
  const users = selectDueUsers(checkpoints, manifests, dependencies.now(), deferred);
  summary.due = users.length;
  const published: string[] = [];
  const failed: string[] = [];
  for (const username of users) {
    const now = dependencies.now().getTime();
    if (limits.deadline.getTime() - now < limits.minUserBudgetMs) {
      summary.stopped = "deadline";
      break;
    }
    if (requests >= limits.maxRequests) {
      summary.stopped = "requests";
      break;
    }
    if (operations.advanced + JOB_ADVANCED_ESTIMATE > allowance) {
      summary.stopped = "blob-budget";
      break;
    }
    summary.processed += 1;
    try {
      const outcome = await runRefreshJob(username, {
        deadline: new Date(Math.min(limits.deadline.getTime(), now + limits.userBudgetMs)),
        maxRequests: limits.maxRequests - requests,
      }, counted);
      summary.statuses[outcome.status] += 1;
      if (outcome.publish === "published") {
        summary.published += 1;
        published.push(username);
      } else if (outcome.status === "failed") {
        failed.push(username);
      }
      if (outcome.rateLimited) {
        summary.stopped = "rate-limit";
        break;
      }
    } catch (error) {
      summary.errors += 1;
      logError("cron.refresh_failed", error);
    }
  }
  if (admissions !== null) {
    const outcome = { published: [...publishedKeys(manifests), ...published], failed };
    const now = dependencies.now();
    // 시작할 때 읽은 기록으로도 바꿀 것이 없으면 쓰지 않아, 변화 없는 실행마다 등록 기록을 다시 읽고 쓰지 않습니다.
    if (reconcileAdmissions(admissions, outcome, now) !== null) {
      try {
        await updateAdmissions(
          store,
          (current) => reconcileAdmissions(current, outcome, now),
          AbortSignal.timeout(CRON_ADMISSIONS_TIMEOUT_MS),
        );
      } catch (error) {
        summary.errors += 1;
        logError("cron.admissions_update_failed", error);
      }
    }
  }
  summary.requests = requests;
}

/**
 * 이번 실행을 시작한 날짜의 사용량 기록에 더합니다. 실패는 오류로 집계합니다.
 * 시작할 때 사용량 기록을 읽지 못한 실행도 목록 조회 등으로 작업을 썼으므로 기록을 시도합니다.
 */
async function recordUsage(store: ObjectStore, startedAt: Date, summary: CronSummary): Promise<void> {
  const run = {
    operations: { ...summary.blob.operations },
    processed: summary.processed,
    published: summary.published,
    requests: summary.requests,
    errors: summary.errors,
  };
  try {
    const usage = await updateUsage(store, startedAt, (current) => addCronUsage(current, run), AbortSignal.timeout(CRON_USAGE_TIMEOUT_MS));
    summary.blob.dailyAdvanced = usage.blob.advanced;
  } catch (error) {
    summary.errors += 1;
    logError("cron.usage_update_failed", error);
  }
  summary.blob.operations.advanced += USAGE_RECORD_OPERATIONS.advanced;
  summary.blob.operations.simple += USAGE_RECORD_OPERATIONS.simple;
}

function publishedKeys(manifests: readonly ObjectEntry[]): string[] {
  return manifests.flatMap((entry) => userKeyFromPathname(MANIFEST_PREFIX, entry.pathname) ?? []);
}

/**
 * Cron 결과를 등록 기록에 반영합니다. 바꿀 것이 없으면 null입니다.
 * - `published`: manifest가 있거나 이번 실행에서 발행한 사용자. 실패 표시를 지웁니다. 실행 시작 때의 manifest 목록도
 *   넣는 이유는 발행 직후 job이 오류로 끝나 이번 결과에 빠진 사용자의 표시도 다음 실행에서 지우기 위해서입니다.
 * - `failed`: 이번 실행에서 발행 없이 수집이 `failed`가 된 사용자. 실패를 표시해 active 수에서 빼고,
 *   이후 카드 요청이 bootstrap을 예약하지 않게 합니다. manifest가 있는 사용자는 `published`가 우선합니다.
 */
function reconcileAdmissions(
  admissions: Admissions,
  outcome: { published: readonly string[]; failed: readonly string[] },
  now: Date,
): Admissions | null {
  const published = new Set(outcome.published);
  const cleared = clearAdmissionFailures(admissions, [...published]);
  const failed = outcome.failed.filter((key) => !published.has(key));
  return markAdmissionFailures(cleared ?? admissions, failed, now) ?? cleared;
}
