import { runRefreshJob, type RefreshDependencies } from "./refresh-job.js";

/** 카드 요청 한 번이 background에서 쓸 수 있는 최대 시간과 GitHub 요청 수입니다. */
export const BOOTSTRAP_BUDGET_MS = 20_000;
export const BOOTSTRAP_MAX_REQUESTS = 20;

/**
 * 발행 이력이 없는 사용자의 수집을 bounded batch 한 번만큼 진행하고, 수집이 끝나면 발행합니다.
 * 실패한 수집은 다시 시작하지 않고(Cron이 재시도), 다른 실행이 lease를 가지고 있으면 GitHub 요청 없이 끝납니다.
 * `waitUntil`에 넘기는 용도이므로 오류는 메시지만 로그로 남기고 던지지 않습니다.
 */
export async function bootstrapUser(username: string, deadline: Date, dependencies: RefreshDependencies): Promise<void> {
  try {
    await runRefreshJob(username, { deadline, maxRequests: BOOTSTRAP_MAX_REQUESTS, resumeFailed: false }, dependencies);
  } catch (error) {
    console.error("Bootstrap failed:", error instanceof Error ? error.message : "unknown error");
  }
}
