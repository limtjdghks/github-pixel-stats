import { isDeepStrictEqual } from "node:util";
import type { CachedCommit, CollectionMetrics, SearchCommit } from "../model.js";
import { CLASSIFIER_VERSION, LINGUIST_VERSION, SNAPSHOT_SCHEMA_VERSION } from "../model.js";
import { parseUsername, usernamesEqual } from "../username.js";
import { assertSnapshot } from "../validation/output.js";
import { CHECKPOINT_SCHEMA_VERSION, type CollectionCheckpoint, type CollectionCursor, type SearchInterval } from "./checkpoint-model.js";
import { assembleCollectionResult, collectionPeriod } from "./collection-model.js";
import { assertCachedCommit, parseState } from "./state-validation.js";
import { commitKey } from "./github-pages.js";

function requireValue(condition: unknown, field: string): asserts condition {
  if (!condition) throw new Error(`Checkpoint has invalid ${field}.`);
}

function record(value: unknown, field: string): Record<string, unknown> {
  requireValue(typeof value === "object" && value !== null && !Array.isArray(value), field);
  return value as Record<string, unknown>;
}

function integer(value: unknown, field: string, minimum = 0): number {
  requireValue(Number.isSafeInteger(value) && Number(value) >= minimum, field);
  return Number(value);
}

function text(value: unknown, field: string): string {
  requireValue(typeof value === "string" && value.length > 0, field);
  return value;
}

function date(value: unknown, field: string): string {
  const result = text(value, field);
  requireValue(Number.isFinite(Date.parse(result)), field);
  return result;
}

function searchedCommits(value: unknown, from: number, to: number): SearchCommit[] {
  requireValue(Array.isArray(value), "search commits");
  const seen = new Set<string>();
  return value.map((item: unknown) => {
    const commit = record(item, "search commit");
    const candidate = { ...commit, languages: [] };
    const key = `${commit.repositoryId}:${commit.sha}`;
    assertCachedCommit(key, candidate);
    const authoredAt = Date.parse(candidate.authoredAt);
    requireValue(authoredAt >= from && authoredAt <= to, "search commit period");
    requireValue(!seen.has(key), "duplicate search commit");
    seen.add(key);
    return {
      repositoryId: candidate.repositoryId,
      repository: candidate.repository,
      sha: candidate.sha,
      authoredAt: candidate.authoredAt,
    };
  });
}

function readMetrics(value: unknown): CollectionMetrics {
  const metrics = record(value, "metrics");
  return {
    searchedCommits: integer(metrics.searchedCommits, "searched metric"),
    cacheHits: integer(metrics.cacheHits, "cache metric"),
    fetchedCommits: integer(metrics.fetchedCommits, "fetched metric"),
    removedCommits: integer(metrics.removedCommits, "removed metric"),
  };
}

function interval(value: unknown, from: number, to: number): SearchInterval {
  const range = record(value, "search interval");
  const start = integer(range.from, "interval start");
  const end = integer(range.to, "interval end");
  requireValue(start >= from && end <= to && start <= end && start % 1000 === 0 && end % 1000 === 0, "search interval bounds");
  return { from: start, to: end };
}

function readCursor(value: unknown, from: number, to: number): CollectionCursor {
  const cursor = record(value, "cursor");
  switch (cursor.stage) {
    case "profile":
    case "complete":
      return { stage: cursor.stage };
    case "repositories":
      return { stage: cursor.stage, page: integer(cursor.page, "repository page", 1) };
    case "search": {
      requireValue(Array.isArray(cursor.pending), "pending search intervals");
      const pending = cursor.pending.map((range: unknown) => interval(range, from, to));
      let current: Extract<CollectionCursor, { stage: "search" }>["current"] = null;
      if (cursor.current !== null) {
        const raw = record(cursor.current, "current search interval");
        const range = interval(raw, from, to);
        const page = integer(raw.page, "search page", 1);
        const totalCount = raw.totalCount === null ? null : integer(raw.totalCount, "search total");
        const commits = searchedCommits(raw.commits, range.from, range.to);
        requireValue(page <= 10 && (totalCount === null ? page === 1 && commits.length === 0 : totalCount <= 1000), "search page progress");
        requireValue(commits.length <= (page - 1) * 100 && (totalCount === null || commits.length <= totalCount), "search count progress");
        current = { ...range, page, totalCount, commits };
      }
      const ranges = [...pending, ...(current ? [current] : [])].sort((left, right) => left.from - right.from);
      requireValue(ranges.every((range, index) => index === 0 || range.from > ranges[index - 1]!.to), "overlapping search intervals");
      return { stage: cursor.stage, pending, current };
    }
    case "details": {
      const index = integer(cursor.index, "detail index");
      const page = integer(cursor.page, "detail page", 1);
      const fileCount = integer(cursor.fileCount, "detail file count");
      requireValue(Array.isArray(cursor.filenames) && cursor.filenames.every((filename) => typeof filename === "string" && filename.length > 0), "detail filenames");
      requireValue(page <= 30 && fileCount < 3000 && fileCount <= (page - 1) * 100 && cursor.filenames.length <= fileCount * 2, "detail page progress");
      requireValue(page !== 1 || fileCount === 0, "first detail page progress");
      return { stage: cursor.stage, index, page, fileCount, filenames: cursor.filenames };
    }
    default:
      throw new Error("Checkpoint has invalid cursor stage.");
  }
}

export function readCheckpoint(value: unknown, expectedUsername: string): CollectionCheckpoint | null {
  const expected = parseUsername(expectedUsername);
  const raw = record(value, "shape");
  if (raw.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) return null;
  const username = text(raw.username, "username");
  requireValue(username === parseUsername(username), "username");
  if (!usernamesEqual(username, expected)) return null;
  const classifier = record(raw.classifier, "classifier");
  if (classifier.version !== CLASSIFIER_VERSION || classifier.linguistVersion !== LINGUIST_VERSION) return null;

  let previous = null;
  if (raw.previous !== null) {
    const loaded = parseState(raw.previous, username, "Checkpoint previous state");
    if (!loaded.cacheUsable) return null;
    previous = loaded.state;
  }
  let result = null;
  if (raw.result !== null) {
    const source = record(raw.result, "result");
    const snapshot = record(source.snapshot, "result snapshot");
    if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) return null;
    const loaded = parseState(source.nextState, username, "Checkpoint result state");
    if (!loaded.cacheUsable) return null;
    requireValue(loaded.state !== null, "result state");
    assertSnapshot(source.snapshot);
    requireValue(usernamesEqual(source.snapshot.username, username), "result username");
    requireValue(typeof source.stateChanged === "boolean", "result state change flag");
    result = { snapshot: source.snapshot, nextState: loaded.state, stateChanged: source.stateChanged, metrics: readMetrics(source.metrics) };
  }

  const rawPeriod = record(raw.period, "period");
  const period = { from: date(rawPeriod.from, "period start"), to: date(rawPeriod.to, "period end") };
  const calculated = collectionPeriod(new Date(period.to));
  requireValue(period.from === calculated.from.toISOString() && period.to === calculated.now.toISOString(), "fixed period");
  const from = Date.parse(period.from);
  const to = Date.parse(period.to);
  const cursor = readCursor(raw.cursor, from, to);
  const searched = searchedCommits(raw.searched, from, to);
  const commits: Record<string, CachedCommit> = {};
  for (const [key, commit] of Object.entries(record(raw.commits, "commit map"))) {
    assertCachedCommit(key, commit);
    commits[key] = commit;
  }
  const metrics = readMetrics(raw.metrics);
  const attempt = integer(raw.attempt, "attempt");
  const retryValue = record(raw.retry, "retry");
  const retry = {
    attempts: integer(retryValue.attempts, "retry attempts"),
    nextAttemptAt: retryValue.nextAttemptAt === null ? null : date(retryValue.nextAttemptAt, "retry date"),
  };
  requireValue(retry.attempts <= 3 && (retry.attempts !== 0 || retry.nextAttemptAt === null), "retry progress");
  let lease = null;
  if (raw.lease !== null) {
    const source = record(raw.lease, "lease");
    lease = { owner: text(source.owner, "lease owner"), expiresAt: date(source.expiresAt, "lease expiry") };
    requireValue(attempt > 0 && raw.status === "collecting", "lease status");
  }
  requireValue(raw.nextRefreshAt === null, "next refresh");
  requireValue(typeof raw.stateLoaded === "boolean", "state loaded flag");
  requireValue(raw.status === "pending" || raw.status === "collecting" || raw.status === "ready" || raw.status === "failed", "status");
  requireValue((raw.status === "ready") === (cursor.stage === "complete" && result !== null), "ready status");
  requireValue((result !== null) === (cursor.stage === "complete"), "completed result");
  requireValue(raw.error === null || typeof raw.error === "string", "error");
  requireValue(raw.status === "failed" ? typeof raw.error === "string" : raw.error === null, "failure status");
  requireValue(raw.stateLoaded || previous === null, "unloaded previous state");
  requireValue(cursor.stage !== "profile" || !raw.stateLoaded, "profile state progress");
  let profile = null;
  if (raw.profile !== null) {
    const source = record(raw.profile, "profile");
    profile = {
      publicRepositories: integer(source.publicRepositories, "repository count"),
      stars: integer(source.stars, "star count"),
    };
  }
  requireValue(cursor.stage === "profile" ? profile === null : profile !== null, "profile progress");
  const startedDetails = cursor.stage === "details" || cursor.stage === "complete";
  const processed = cursor.stage === "details" ? cursor.index : cursor.stage === "complete" ? searched.length : 0;
  requireValue(!startedDetails || raw.stateLoaded, "state progress");
  requireValue(cursor.stage !== "search" || raw.stateLoaded, "search state progress");
  requireValue(processed <= searched.length && Object.keys(commits).length === processed, "processed commit count");
  const completed = searched.slice(0, processed);
  for (const commit of completed) {
    const cached = commits[commitKey(commit)];
    requireValue(cached && cached.repository === commit.repository && cached.authoredAt === commit.authoredAt, "processed commit prefix");
    const prior = previous?.commits[commitKey(commit)];
    requireValue(!prior || isDeepStrictEqual(cached.languages, prior.languages), "cached languages");
  }
  const hits = completed.filter((commit) => previous?.commits[commitKey(commit)] !== undefined).length;
  requireValue(metrics.cacheHits === hits && metrics.fetchedCommits === processed - hits, "processed metrics");
  requireValue(metrics.searchedCommits === (startedDetails ? searched.length : 0), "searched metrics");
  const keys = new Set(searched.map(commitKey));
  const removed = startedDetails && previous ? Object.keys(previous.commits).filter((key) => !keys.has(key)).length : 0;
  requireValue(metrics.removedCommits === removed, "removed metrics");
  requireValue(!["profile", "repositories"].includes(cursor.stage) || searched.length === 0, "premature searched commits");
  if (cursor.stage === "search") {
    const remaining = [...cursor.pending, ...(cursor.current ? [cursor.current] : [])];
    requireValue(searched.every((commit) => remaining.every((range) => Date.parse(commit.authoredAt) < range.from || Date.parse(commit.authoredAt) > range.to)), "completed search intervals");
  }
  if (cursor.stage === "details" && cursor.index === searched.length) {
    requireValue(cursor.page === 1 && cursor.fileCount === 0 && cursor.filenames.length === 0, "completed details");
  }
  if (result !== null) {
    requireValue(profile !== null, "completed profile");
    const colors = new Map(result.snapshot.languages.map((language) => [language.name, language.color]));
    const assembled = assembleCollectionResult({
      username, now: new Date(period.to), from: new Date(period.from),
      publicRepositories: profile.publicRepositories, stars: profile.stars,
      searchedCommits: searched.length, commits: new Map(Object.entries(commits)),
      previous, metrics, classifier: { colorFor: (language) => colors.get(language) ?? "#000000" },
    });
    requireValue(isDeepStrictEqual(result, assembled), "result consistency");
    requireValue(lease === null && retry.attempts === 0 && retry.nextAttemptAt === null, "completed execution");
  }
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION, jobId: text(raw.jobId, "job ID"), username,
    classifier: { version: CLASSIFIER_VERSION, linguistVersion: LINGUIST_VERSION },
    period, status: raw.status, cursor, attempt, lease, nextRefreshAt: null, retry, profile,
    previous, stateLoaded: raw.stateLoaded, searched, commits, metrics, result, error: raw.error,
  };
}
