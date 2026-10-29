import { updateAdmissions } from "../storage/admissions.js";
import type { ObjectStore } from "../storage/object-store.js";
import { countOperations, emptyOperationCount } from "../storage/operation-count.js";
import { userKey } from "../storage/pathnames.js";
import { readUsage, updateUsage } from "../storage/usage.js";
import { admissionDecision, admitUser, markAdmissionFailures } from "./admission-policy.js";
import { logError, logEvent } from "./log.js";
import { runRefreshJob, type RefreshDependencies } from "./refresh-job.js";
import { addBootstrapUsage, bootstrapAllowed } from "./usage-policy.js";

/** 카드 요청 한 번이 background에서 쓸 수 있는 최대 시간과 GitHub 요청 수입니다. */
export const BOOTSTRAP_BUDGET_MS = 20_000;
export const BOOTSTRAP_MAX_REQUESTS = 20;
/** 수집 job을 deadline보다 이만큼 일찍 끝내 등록 기록의 실패 표시와 사용량 기록을 쓸 시간을 남깁니다. */
export const BOOTSTRAP_RECORD_RESERVE_MS = 2_000;

/** 상한 안이면 등록하고, 이번 bootstrap이 수집을 진행해도 되는지 반환합니다. */
async function admit(store: ObjectStore, key: string, now: Date, signal: AbortSignal): Promise<boolean> {
  const admissions = await updateAdmissions(store, (current) => admitUser(current, key, now), signal);
  return admissionDecision(admissions, key, now) === "admitted";
}

/**
 * 등록 기록 쓰기가 bootstrap deadline을 넘지 않게 하는 signal입니다.
 * 실패 표시가 deadline에 걸려 빠져도, 다음 카드 요청의 bootstrap이 GitHub 요청 없이 `failed`를 확인해 다시 표시합니다.
 */
function untilDeadline(deadline: Date, now: Date): AbortSignal {
  return AbortSignal.timeout(Math.max(0, deadline.getTime() - now.getTime()));
}

/**
 * 발행 이력이 없는 사용자를 등록하고 수집을 bounded batch 한 번만큼 진행하며, 수집이 끝나면 발행합니다.
 * 오늘의 Blob Advanced Operation 예산(전체와 bootstrap 몫)에 job 하나를 시작할 여유가 없거나 사용량 기록을 읽지 못하면
 * 등록 없이 끝납니다. 등록 상한에 도달했거나 실패 표시된 사용자는 GitHub 요청 없이 끝납니다. 수집이 `failed`가 되면
 * 등록 기록에 실패를 표시해 이후 카드 요청이 bootstrap을 예약하지 않게 하며, 재시도는 Cron이 맡습니다.
 * 다른 실행이 lease를 가지고 있으면 GitHub 요청 없이 끝납니다. Blob 쓰기나 list를 한 실행은 끝에 사용량 기록에 더합니다.
 * `waitUntil`에 넘기는 용도이므로 오류는 로그로만 남기고 던지지 않습니다.
 */
export async function bootstrapUser(username: string, deadline: Date, dependencies: RefreshDependencies): Promise<void> {
  const store = dependencies.stores.privateStore;
  const startedAt = dependencies.now();
  const operations = emptyOperationCount();
  const run = { published: false, requests: 0 };
  try {
    // 사용량 기록 자체의 읽기·쓰기는 `addBootstrapUsage()`가 따로 더하므로 집계 범위 밖에서 합니다.
    const { usage } = await readUsage(store, startedAt, untilDeadline(deadline, startedAt));
    if (!bootstrapAllowed(usage)) {
      logEvent("bootstrap.skipped", { reason: "blob-budget" });
      return;
    }
    // job이 오류로 끝나도 이미 보낸 GitHub 요청이 사용량 기록에 남도록 요청 자체를 셉니다.
    const counted: RefreshDependencies = {
      ...dependencies,
      github: {
        requestPage(request, signal) {
          run.requests += 1;
          return dependencies.github.requestPage(request, signal);
        },
      },
    };
    await countOperations(operations, async () => {
      const key = userKey(username);
      if (!(await admit(store, key, startedAt, untilDeadline(deadline, startedAt)))) return;
      const outcome = await runRefreshJob(username, {
        deadline: new Date(deadline.getTime() - BOOTSTRAP_RECORD_RESERVE_MS),
        maxRequests: BOOTSTRAP_MAX_REQUESTS,
        resumeFailed: false,
      }, counted);
      run.published = outcome.publish === "published";
      if (outcome.status === "failed") {
        const failedAt = dependencies.now();
        await updateAdmissions(store, (current) => markAdmissionFailures(current, [key], failedAt), untilDeadline(deadline, failedAt));
      }
      // `blobAdvanced`는 사용량 기록 쓰기를 뺀 이 실행의 작업 수로, job 추정치(`JOB_ADVANCED_ESTIMATE`)를 실측하는 데 씁니다.
      logEvent("bootstrap.completed", {
        status: outcome.status, publish: outcome.publish, requests: run.requests, skippedCommits: outcome.skippedCommits,
        blobAdvanced: operations.advanced,
      });
    });
  } catch (error) {
    logError("bootstrap.failed", error);
  }
  await recordUsage(store, startedAt, deadline, { operations, ...run }, dependencies.now());
}

/** Advanced Operation을 쓴 실행만 기록합니다. 읽기만 한 실행까지 기록하면 기록 쓰기가 예산을 씁니다. */
async function recordUsage(
  store: ObjectStore,
  startedAt: Date,
  deadline: Date,
  run: Parameters<typeof addBootstrapUsage>[1],
  now: Date,
): Promise<void> {
  if (run.operations.advanced === 0) return;
  try {
    await updateUsage(store, startedAt, (current) => addBootstrapUsage(current, run), untilDeadline(deadline, now));
  } catch (error) {
    logError("bootstrap.usage_update_failed", error);
  }
}
