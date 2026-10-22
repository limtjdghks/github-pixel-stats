import { updateAdmissions } from "../storage/admissions.js";
import type { ObjectStore } from "../storage/object-store.js";
import { userKey } from "../storage/pathnames.js";
import { admissionDecision, admitUser, markAdmissionFailures } from "./admission-policy.js";
import { runRefreshJob, type RefreshDependencies } from "./refresh-job.js";

/** 카드 요청 한 번이 background에서 쓸 수 있는 최대 시간과 GitHub 요청 수입니다. */
export const BOOTSTRAP_BUDGET_MS = 20_000;
export const BOOTSTRAP_MAX_REQUESTS = 20;

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
 * 등록 상한에 도달했거나 실패 표시된 사용자는 GitHub 요청 없이 끝납니다. 수집이 `failed`가 되면 등록 기록에
 * 실패를 표시해 이후 카드 요청이 bootstrap을 예약하지 않게 하며, 재시도는 Cron이 맡습니다.
 * 다른 실행이 lease를 가지고 있으면 GitHub 요청 없이 끝납니다.
 * `waitUntil`에 넘기는 용도이므로 오류는 메시지만 로그로 남기고 던지지 않습니다.
 */
export async function bootstrapUser(username: string, deadline: Date, dependencies: RefreshDependencies): Promise<void> {
  try {
    const store = dependencies.stores.privateStore;
    const key = userKey(username);
    const now = dependencies.now();
    if (!(await admit(store, key, now, untilDeadline(deadline, now)))) return;
    const outcome = await runRefreshJob(username, { deadline, maxRequests: BOOTSTRAP_MAX_REQUESTS, resumeFailed: false }, dependencies);
    if (outcome.status === "failed") {
      const failedAt = dependencies.now();
      await updateAdmissions(store, (current) => markAdmissionFailures(current, [key], failedAt), untilDeadline(deadline, failedAt));
    }
  } catch (error) {
    console.error("Bootstrap failed:", error instanceof Error ? error.message : "unknown error");
  }
}
