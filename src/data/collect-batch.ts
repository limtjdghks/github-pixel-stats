import { CLASSIFIER_VERSION, LINGUIST_VERSION } from "../model.js";
import { parseUsername } from "../username.js";
import { collectionPeriod } from "./collection-model.js";
import {
  CHECKPOINT_SCHEMA_VERSION,
  type BatchDependencies,
  type BatchOptions,
  type BatchResult,
  type CollectionCheckpoint,
} from "./checkpoint-model.js";
import { readCheckpoint } from "./checkpoint-validation.js";
import { acceptPage, advanceWithoutRequest, nextPageRequest } from "./checkpoint-progress.js";
import { GitHubRequestError, MAX_RATE_LIMIT_WAIT_MS, MAX_RETRIES } from "./github-pages.js";
import { parseState } from "./state-validation.js";

class LeaseConflict extends Error {}
class CheckpointWriteFailure extends Error {}

function abortAt(delay: number): { signal: AbortSignal; close(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Batch deadline reached.")), Math.max(0, delay));
  if (delay <= 0) {
    controller.abort(new Error("Batch deadline reached."));
  }
  return { signal: controller.signal, close: () => clearTimeout(timer) };
}

function withinDeadline<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        if (signal.aborted) {
          reject(signal.reason);
        } else {
          resolve(value);
        }
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
    if (signal.aborted) {
      aborted();
    }
  });
}

function newCheckpoint(username: string, dependencies: BatchDependencies): CollectionCheckpoint {
  const { now, from } = collectionPeriod(dependencies.now());
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    jobId: dependencies.newId(),
    username,
    classifier: { version: CLASSIFIER_VERSION, linguistVersion: LINGUIST_VERSION },
    period: { from: from.toISOString(), to: now.toISOString() },
    status: "pending",
    cursor: { stage: "profile" },
    attempt: 0,
    lease: null,
    nextRefreshAt: null,
    retry: { attempts: 0, nextAttemptAt: null },
    profile: null,
    previous: null,
    stateLoaded: false,
    searched: [],
    commits: {},
    metrics: { searchedCommits: 0, cacheHits: 0, fetchedCommits: 0, removedCommits: 0 },
    result: null,
    error: null,
  };
}

function assertOptions(options: BatchOptions): void {
  if (
    !Number.isFinite(options.deadline.getTime()) ||
    !Number.isSafeInteger(options.checkpointReserveMs) || options.checkpointReserveMs <= 0 ||
    !Number.isSafeInteger(options.maxRequests) || options.maxRequests < 0 ||
    (options.maxNewCommits !== undefined && (!Number.isSafeInteger(options.maxNewCommits) || options.maxNewCommits < 0))
  ) {
    throw new Error("Invalid collection batch limits.");
  }
}

export async function collectStatsBatch(options: BatchOptions, dependencies: BatchDependencies): Promise<BatchResult> {
  assertOptions(options);
  const username = parseUsername(options.username);
  const key = username.toLowerCase();
  const deadline = options.deadline.getTime();
  const cutoff = deadline - options.checkpointReserveMs;
  const clock = () => dependencies.now().getTime();
  let requests = 0;
  let checkpoint: CollectionCheckpoint | null = null;
  const response = (status: BatchResult["status"]): BatchResult => ({
    status,
    checkpoint,
    requests,
    result: status === "ready" ? checkpoint?.result ?? null : null,
  });
  if (clock() >= cutoff) {
    return response("paused");
  }

  const hardDeadline = abortAt(deadline - clock());
  const workDeadline = abortAt(cutoff - clock());
  try {
    const stored = await withinDeadline(dependencies.checkpoints.load(key, hardDeadline.signal), hardDeadline.signal);
    checkpoint = stored ? readCheckpoint(stored.value, username) : null;
    if (checkpoint?.status === "ready") {
      return response("ready");
    }
    if (checkpoint?.lease && Date.parse(checkpoint.lease.expiresAt) > clock()) {
      return response("busy");
    }
    if (checkpoint?.retry.nextAttemptAt && Date.parse(checkpoint.retry.nextAttemptAt) > clock()) {
      return response("paused");
    }
    if (clock() >= cutoff || workDeadline.signal.aborted) {
      return response("paused");
    }
    checkpoint ??= newCheckpoint(username, dependencies);
    let revision = stored?.revision ?? null;
    const owner = dependencies.newId();
    if (checkpoint.status === "failed") {
      checkpoint.retry = { attempts: 0, nextAttemptAt: null };
    }
    checkpoint.status = "collecting";
    checkpoint.error = null;
    checkpoint.attempt += 1;
    checkpoint.lease = { owner, expiresAt: options.deadline.toISOString() };
    const acquired = await withinDeadline(dependencies.checkpoints.compareAndSwap(
      key, revision, checkpoint, null, hardDeadline.signal,
    ), hardDeadline.signal);
    if (acquired === null) {
      checkpoint = null;
      return response("conflict");
    }
    revision = acquired;
    let lastSaved = structuredClone(checkpoint);
    const initialFetched = checkpoint.metrics.fetchedCommits;

    const persist = async (release = false): Promise<void> => {
      if (!checkpoint || clock() >= deadline || hardDeadline.signal.aborted) {
        throw new LeaseConflict("Collection lease expired.");
      }
      if (release) {
        checkpoint.lease = null;
      }
      let nextRevision: string | null;
      try {
        nextRevision = await withinDeadline(dependencies.checkpoints.compareAndSwap(
          key, revision, checkpoint, { owner, now: dependencies.now().toISOString() }, hardDeadline.signal,
        ), hardDeadline.signal);
      } catch (error) {
        throw new CheckpointWriteFailure("Checkpoint save failed.", { cause: error });
      }
      if (nextRevision === null) {
        throw new LeaseConflict("Collection checkpoint changed concurrently.");
      }
      revision = nextRevision;
      lastSaved = structuredClone(checkpoint);
    };

    const pause = async (): Promise<BatchResult> => {
      await persist(true);
      return response("paused");
    };

    try {
      let classifier: Awaited<ReturnType<BatchDependencies["loadClassifier"]>>;
      try {
        classifier = await withinDeadline(dependencies.loadClassifier(), workDeadline.signal);
      } catch (error) {
        if (workDeadline.signal.aborted || clock() >= cutoff) {
          return await pause();
        }
        throw error;
      }

      while (checkpoint.cursor.stage !== "complete") {
        if (clock() >= cutoff || workDeadline.signal.aborted) {
          return await pause();
        }
        if (checkpoint.profile && !checkpoint.stateLoaded) {
          let loaded: Awaited<ReturnType<BatchDependencies["loadState"]>>;
          try {
            loaded = await withinDeadline(dependencies.loadState(checkpoint.username), workDeadline.signal);
          } catch (error) {
            if (workDeadline.signal.aborted || clock() >= cutoff) {
              return await pause();
            }
            throw error;
          }
          checkpoint.previous = loaded.cacheUsable && loaded.state
            ? parseState(loaded.state, checkpoint.username).state
            : null;
          checkpoint.stateLoaded = true;
          await persist();
        }
        if (advanceWithoutRequest(checkpoint, classifier)) {
          if (checkpoint.result !== null) {
            await persist(true);
            return response("ready");
          }
          await persist();
          continue;
        }
        if (
          clock() >= cutoff || workDeadline.signal.aborted ||
          requests >= options.maxRequests ||
          (checkpoint.cursor.stage === "details" &&
            checkpoint.metrics.fetchedCommits - initialFetched >= (options.maxNewCommits ?? Infinity))
        ) {
          return await pause();
        }
        const request = nextPageRequest(checkpoint);
        let page;
        try {
          requests += 1;
          page = await withinDeadline(dependencies.github.requestPage(request, workDeadline.signal), workDeadline.signal);
        } catch (error) {
          if (workDeadline.signal.aborted || clock() >= cutoff) {
            return await pause();
          }
          if (
            error instanceof GitHubRequestError && error.retryDelayMs !== null &&
            error.retryDelayMs <= MAX_RATE_LIMIT_WAIT_MS && checkpoint.retry.attempts < MAX_RETRIES
          ) {
            checkpoint.retry.attempts += 1;
            checkpoint.retry.nextAttemptAt = new Date(clock() + error.retryDelayMs).toISOString();
            return await pause();
          }
          throw error;
        }
        if (clock() >= cutoff || workDeadline.signal.aborted) {
          return await pause();
        }
        const beforePage = structuredClone(checkpoint);
        try {
          acceptPage(checkpoint, page, classifier);
        } catch (error) {
          checkpoint = beforePage;
          throw error;
        }
        checkpoint.retry = { attempts: 0, nextAttemptAt: null };
        await persist();
      }
      throw new Error("Completed cursor has no collection result.");
    } catch (error) {
      if (error instanceof LeaseConflict) {
        checkpoint = lastSaved;
        return response("conflict");
      }
      if (error instanceof CheckpointWriteFailure) {
        throw error.cause;
      }
      checkpoint = structuredClone(lastSaved);
      checkpoint.status = "failed";
      checkpoint.error = error instanceof Error ? error.message : String(error);
      checkpoint.retry.nextAttemptAt = null;
      try {
        await persist(true);
      } catch (failure) {
        if (failure instanceof LeaseConflict) {
          checkpoint = lastSaved;
          return response("conflict");
        }
        throw failure instanceof CheckpointWriteFailure ? failure.cause : failure;
      }
      return response("failed");
    }
  } finally {
    hardDeadline.close();
    workDeadline.close();
  }
}
