import type { BatchResult } from "../data/checkpoint-model.js";
import { CHECKPOINT_PREFIX, MANIFEST_PREFIX } from "../storage/pathnames.js";
import { boundedDeadline } from "./invocation-deadline.js";
import { PUBLISH_RESERVE_MS, runRefreshJob, type RefreshDependencies } from "./refresh-job.js";
import { selectDueUsers } from "./refresh-policy.js";

/** Cron 한 번의 전체 시간 예산입니다. `vercel.json`의 cron `maxDuration`(300초)보다 짧아야 합니다. */
export const CRON_BUDGET_MS = 280_000;
const CRON_DEADLINE_MARGIN_MS = 10_000;
/** 한 실행의 GitHub 요청 상한입니다. token의 시간당 한도(5,000회) 안에서 bootstrap 몫을 남겨 둡니다. */
export const CRON_MAX_REQUESTS = 1_000;
/** 한 사용자가 독점할 수 있는 시간입니다. 남은 사용자는 다음 실행에서 이어서 처리합니다. */
export const CRON_USER_BUDGET_MS = 60_000;
/** 발행 여유와 batch 한 번을 진행할 시간이 남지 않으면 다음 사용자를 시작하지 않습니다. */
export const CRON_MIN_USER_BUDGET_MS = PUBLISH_RESERVE_MS + 10_000;

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
  stopped: "complete" | "deadline" | "requests" | "rate-limit";
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
 * 목록 조회 실패는 그대로 던집니다.
 */
export async function runCron(limits: CronLimits, dependencies: RefreshDependencies): Promise<CronSummary> {
  const store = dependencies.stores.privateStore;
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
  const users = selectDueUsers(checkpoints, manifests, dependencies.now());
  const summary: CronSummary = {
    due: users.length,
    processed: 0,
    published: 0,
    requests: 0,
    errors: 0,
    statuses: { paused: 0, busy: 0, conflict: 0, failed: 0, ready: 0 },
    stopped: "complete",
  };
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
    summary.processed += 1;
    try {
      const outcome = await runRefreshJob(username, {
        deadline: new Date(Math.min(limits.deadline.getTime(), now + limits.userBudgetMs)),
        maxRequests: limits.maxRequests - requests,
      }, counted);
      summary.statuses[outcome.status] += 1;
      if (outcome.publish === "published") summary.published += 1;
      if (outcome.rateLimited) {
        summary.stopped = "rate-limit";
        break;
      }
    } catch (error) {
      summary.errors += 1;
      console.error("Cron refresh failed:", error instanceof Error ? error.message : "unknown error");
    }
  }
  summary.requests = requests;
  return summary;
}
