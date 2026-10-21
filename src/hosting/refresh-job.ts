import { collectStatsBatch } from "../data/collect-batch.js";
import type { BatchDependencies, BatchResult } from "../data/checkpoint-model.js";
import type { LinguistClassifier } from "../data/linguist.js";
import type { CardStores } from "../storage/published-card.js";
import { publishRelease, type PublishOutcome } from "../storage/publish.js";
import { REFRESH_INTERVAL_MS } from "./refresh-policy.js";

/**
 * 수집 batch가 끝난 뒤 발행(렌더링·검증·Blob 쓰기)에 남겨 두는 시간입니다.
 * 발행은 abort signal을 받지 않으므로 batch deadline을 이만큼 앞당겨 전체 deadline을 넘기지 않게 합니다.
 */
export const PUBLISH_RESERVE_MS = 5_000;
const CHECKPOINT_RESERVE_MS = 1_000;

export interface RefreshDependencies extends Omit<BatchDependencies, "loadClassifier"> {
  stores: CardStores;
  loadClassifier(): Promise<LinguistClassifier>;
}

export interface RefreshLimits {
  deadline: Date;
  maxRequests: number;
  /** false이면 실패한 수집을 다시 시작하지 않습니다. bootstrap처럼 요청이 반복될 수 있는 호출에 사용합니다. */
  resumeFailed?: boolean;
}

export interface RefreshOutcome {
  /** 마지막 batch 상태입니다. 발행 시간이 남지 않았으면 batch 없이 `paused`입니다. */
  status: BatchResult["status"];
  /** 이번 실행의 마지막 발행 결과입니다. 발행하지 않았으면 null입니다. */
  publish: PublishOutcome["status"] | null;
  requests: number;
  /** 이번 실행이 GitHub rate limit으로 멈췄습니다. 같은 token을 쓰는 다른 작업도 멈추는 것이 좋습니다. */
  rateLimited: boolean;
}

/**
 * 사용자 한 명을 deadline과 요청 상한 안에서 갱신합니다.
 * batch 수집이 `ready`가 되면 발행하고, 발행이 확인된 결과가 `REFRESH_INTERVAL_MS`보다 오래됐으면
 * 같은 실행에서 새 수집 job을 시작합니다. 동시에 실행돼도 checkpoint lease와 manifest 조건부 교체로 한 실행만 전진합니다.
 * 저장소·발행 오류는 그대로 던지며, 그때까지 저장된 checkpoint와 마지막 성공 manifest는 유지됩니다.
 */
export async function runRefreshJob(
  username: string,
  limits: RefreshLimits,
  dependencies: RefreshDependencies,
): Promise<RefreshOutcome> {
  const batchDeadline = new Date(limits.deadline.getTime() - PUBLISH_RESERVE_MS);
  let requests = 0;
  let publish: PublishOutcome["status"] | null = null;
  let restartReadyUntil: Date | undefined;

  // 첫 batch는 저장된 결과를 발행하고, 두 번째 batch는 발행이 확인된 오래된 결과를 새 job으로 바꿉니다.
  for (let pass = 0; pass < 2; pass += 1) {
    if (dependencies.now() >= batchDeadline) {
      return { status: "paused", publish, requests, rateLimited: false };
    }
    const batch = await collectStatsBatch({
      username,
      deadline: batchDeadline,
      checkpointReserveMs: CHECKPOINT_RESERVE_MS,
      maxRequests: limits.maxRequests - requests,
      ...(limits.resumeFailed === undefined ? {} : { resumeFailed: limits.resumeFailed }),
      ...(restartReadyUntil === undefined ? {} : { restartReadyUntil }),
    }, dependencies);
    requests += batch.requests;
    const done = (): RefreshOutcome => ({
      status: batch.status,
      publish,
      requests,
      rateLimited: batch.rateLimitedUntil !== null,
    });
    if (batch.status !== "ready" || batch.result === null || batch.checkpoint === null) return done();

    const published = await publishRelease(batch.result, {
      ...dependencies.stores,
      classifier: await dependencies.loadClassifier(),
      now: dependencies.now,
    });
    publish = published.status;
    const cutoff = dependencies.now().getTime() - REFRESH_INTERVAL_MS;
    if (pass === 1 || published.status === "conflict" || Date.parse(batch.checkpoint.period.to) > cutoff) return done();
    restartReadyUntil = new Date(cutoff);
  }
  throw new Error("Unreachable refresh pass.");
}
