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
import { acceptPage, advanceWithoutRequest, nextPageRequest, skipCommitDetail } from "./checkpoint-progress.js";
import { isUnavailableCommitDetail, retryDecision } from "./github-pages.js";
import { parseState } from "./state-validation.js";

/**
 * 수집 중 checkpoint 저장의 최소 간격입니다. checkpoint 쓰기는 Blob Advanced Operation이므로 GitHub 페이지마다 저장하지
 * 않고, pause·완료·실패 때는 간격과 관계없이 저장합니다. Function이 강제로 끝나거나, 수집이 실패하거나, pause·완료 저장
 * 자체가 실패하면 마지막 저장 뒤 받은 페이지는 사라지고 다음 batch가 같은 페이지를 다시 요청합니다.
 */
export const CHECKPOINT_SAVE_INTERVAL_MS = 10_000;

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
    metrics: { searchedCommits: 0, cacheHits: 0, fetchedCommits: 0, skippedCommits: 0, removedCommits: 0 },
    result: null,
    error: null,
  };
}

function assertOptions(options: BatchOptions): void {
  if (
    !Number.isFinite(options.deadline.getTime()) ||
    !Number.isSafeInteger(options.checkpointReserveMs) || options.checkpointReserveMs <= 0 ||
    !Number.isSafeInteger(options.maxRequests) || options.maxRequests < 0 ||
    (options.maxNewCommits !== undefined && (!Number.isSafeInteger(options.maxNewCommits) || options.maxNewCommits < 0)) ||
    (options.restartReadyUntil !== undefined && !Number.isFinite(options.restartReadyUntil.getTime())) ||
    (options.checkpointIntervalMs !== undefined &&
      (!Number.isSafeInteger(options.checkpointIntervalMs) || options.checkpointIntervalMs < 0))
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
  let skippedCommits = 0;
  let checkpoint: CollectionCheckpoint | null = null;
  let rateLimitedUntil: string | null = null;
  const response = (status: BatchResult["status"]): BatchResult => ({
    status,
    checkpoint,
    requests,
    skippedCommits,
    result: status === "ready" ? checkpoint?.result ?? null : null,
    rateLimitedUntil: status === "paused" ? rateLimitedUntil : null,
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
      if (
        options.restartReadyUntil === undefined ||
        Date.parse(checkpoint.period.to) > options.restartReadyUntil.getTime()
      ) {
        return response("ready");
      }
      // 발행이 확인된 결과만 이 옵션으로 들어오므로, 같은 revision 위에 새 job을 조건부로 덮어씁니다.
      checkpoint = null;
    }
    if (checkpoint?.status === "failed" && options.resumeFailed === false) {
      return response("failed");
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
    let lastSavedAt = clock();
    const saveInterval = options.checkpointIntervalMs ?? CHECKPOINT_SAVE_INTERVAL_MS;
    const initialFetched = checkpoint.metrics.fetchedCommits;
    const initialSkipped = checkpoint.metrics.skippedCommits;

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
      // 저장된 진행만 셉니다. 저장 전 건너뛰기는 충돌·실패 시 `lastSaved`로 되돌아가 다음 실행이 다시 건너뜁니다.
      skippedCommits = lastSaved.metrics.skippedCommits - initialSkipped;
      lastSavedAt = clock();
    };

    // 진행 중 저장만 간격을 둡니다. 저장하지 않은 진행은 실패 처리 시 `lastSaved`로 되돌아갑니다.
    const saveProgress = async (): Promise<void> => {
      if (clock() - lastSavedAt >= saveInterval) await persist();
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
          await saveProgress();
        }
        if (advanceWithoutRequest(checkpoint, classifier)) {
          if (checkpoint.result !== null) {
            await persist(true);
            return response("ready");
          }
          await saveProgress();
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
          const retry = retryDecision(error, checkpoint.retry.attempts);
          if (retry !== null) {
            // rate limit은 일시 오류 재시도 횟수를 소모하지 않고 reset까지 기다립니다.
            if (retry.kind === "transient") checkpoint.retry.attempts += 1;
            checkpoint.retry.nextAttemptAt = new Date(clock() + retry.delayMs).toISOString();
            if (retry.kind === "rate-limit") rateLimitedUntil = checkpoint.retry.nextAttemptAt;
            return await pause();
          }
          if (request.kind === "files" && isUnavailableCommitDetail(error)) {
            skipCommitDetail(checkpoint);
            checkpoint.retry = { attempts: 0, nextAttemptAt: null };
            await saveProgress();
            continue;
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
        await saveProgress();
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
