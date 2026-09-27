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
}
