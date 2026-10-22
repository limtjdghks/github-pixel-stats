import type { CachedCommit, CollectionMetrics, CollectionResult, CollectorState, SearchCommit } from "../model.js";
import type { CollectionDependencies } from "./collection-ports.js";
import type { GitHubPageSource } from "./github-pages.js";

export const CHECKPOINT_SCHEMA_VERSION = 1 as const;

export interface SearchInterval {
  from: number;
  to: number;
}

export type CollectionCursor =
  | { stage: "profile" }
  | { stage: "repositories"; page: number }
  | { stage: "search"; pending: SearchInterval[]; current: (SearchInterval & {
      page: number; totalCount: number | null; commits: SearchCommit[];
    }) | null }
  | { stage: "details"; index: number; page: number; filenames: string[]; fileCount: number }
  | { stage: "complete" };

export interface CollectionCheckpoint {
  schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION;
  jobId: string;
  username: string;
  classifier: { version: number; linguistVersion: string };
  period: { from: string; to: string };
  status: "pending" | "collecting" | "ready" | "failed";
  cursor: CollectionCursor;
  attempt: number;
  lease: { owner: string; expiresAt: string } | null;
  nextRefreshAt: null;
  /** `attempts`는 5xx·네트워크 오류 재시도 횟수이며, rate limit 대기는 `nextAttemptAt`만 설정합니다. */
  retry: { attempts: number; nextAttemptAt: string | null };
  profile: { publicRepositories: number; stars: number } | null;
  previous: CollectorState | null;
  stateLoaded: boolean;
  searched: SearchCommit[];
  commits: Record<string, CachedCommit>;
  metrics: CollectionMetrics;
  result: CollectionResult | null;
  error: string | null;
}

export interface StoredCheckpoint {
  revision: string;
  value: unknown;
}

export interface CheckpointStore {
  load(key: string, signal: AbortSignal): Promise<StoredCheckpoint | null>;
  compareAndSwap(
    key: string,
    expectedRevision: string | null,
    checkpoint: CollectionCheckpoint,
    guard: { owner: string; now: string } | null,
    signal: AbortSignal,
  ): Promise<string | null>;
}

export interface BatchOptions {
  username: string;
  deadline: Date;
  checkpointReserveMs: number;
  maxRequests: number;
  maxNewCommits?: number;
  /**
   * `ready` checkpoint의 수집 기간 끝(`period.to`)이 이 시각과 같거나 이르면 결과를 버리고 새 job을 시작합니다.
   * 결과가 manifest에 발행된 것을 확인한 호출자만 넘겨야 합니다. 생략하면 `ready`를 그대로 반환합니다.
   */
  restartReadyUntil?: Date;
  /** false이면 `failed` checkpoint를 재시작하지 않고 GitHub 요청 없이 `failed`를 반환합니다. 기본값은 재시작입니다. */
  resumeFailed?: boolean;
  /** 수집 중 checkpoint를 저장하는 최소 간격입니다. 기본값은 `CHECKPOINT_SAVE_INTERVAL_MS`입니다. */
  checkpointIntervalMs?: number;
}

export interface BatchDependencies extends Pick<CollectionDependencies, "loadState" | "loadClassifier" | "now"> {
  github: GitHubPageSource;
  checkpoints: CheckpointStore;
  newId(): string;
}

export interface BatchResult {
  status: "paused" | "busy" | "conflict" | "failed" | "ready";
  checkpoint: CollectionCheckpoint | null;
  requests: number;
  result: CollectionResult | null;
  /** 이번 batch가 GitHub rate limit으로 멈췄으면 재시도 가능 시각입니다. 같은 token의 다른 작업도 이때까지 기다리는 것이 좋습니다. */
  rateLimitedUntil: string | null;
}
