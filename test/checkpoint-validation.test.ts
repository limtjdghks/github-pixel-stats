import assert from "node:assert/strict";
import test from "node:test";
import type { CollectionCheckpoint } from "../src/data/checkpoint-model.js";
import { CHECKPOINT_SCHEMA_VERSION } from "../src/data/checkpoint-model.js";
import { readCheckpoint } from "../src/data/checkpoint-validation.js";
import { assembleCollectionResult, collectionPeriod } from "../src/data/collection-model.js";
import { parseState } from "../src/data/state-validation.js";
import { CLASSIFIER_VERSION, LINGUIST_VERSION, STATE_SCHEMA_VERSION } from "../src/model.js";

function checkpoint(): CollectionCheckpoint {
  const { now, from } = collectionPeriod(new Date("2026-09-27T00:00:00Z"));
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    jobId: "job-1", username: "fixture-alpha",
    classifier: { version: CLASSIFIER_VERSION, linguistVersion: LINGUIST_VERSION },
    period: { from: from.toISOString(), to: now.toISOString() },
    status: "pending", cursor: { stage: "profile" }, attempt: 0, lease: null,
    nextRefreshAt: null, retry: { attempts: 0, nextAttemptAt: null },
    profile: null, previous: null, stateLoaded: false, searched: [], commits: {},
    metrics: { searchedCommits: 0, fetchedCommits: 0, cacheHits: 0, removedCommits: 0 },
    result: null, error: null,
  };
}

function details(): CollectionCheckpoint {
  const value = checkpoint();
  value.cursor = { stage: "details", index: 1, page: 1, filenames: [], fileCount: 0 };
  value.status = "collecting";
  value.attempt = 1;
  value.profile = { publicRepositories: 1, stars: 2 };
  value.stateLoaded = true;
  const commit = { repositoryId: 1, repository: "fixture-alpha/repo", sha: "a".repeat(40), authoredAt: "2026-08-01T00:00:00Z" };
  value.searched = [commit];
  value.commits = { [`1:${commit.sha}`]: { ...commit, languages: ["TypeScript"] } };
  value.metrics.searchedCommits = 1;
  value.metrics.fetchedCommits = 1;
  return value;
}

function completed(): CollectionCheckpoint {
  const value = details();
  value.result = assembleCollectionResult({
    username: value.username, now: new Date(value.period.to), from: new Date(value.period.from),
    publicRepositories: value.profile!.publicRepositories, stars: value.profile!.stars,
    searchedCommits: 1, commits: new Map(Object.entries(value.commits)), previous: null,
    metrics: value.metrics, classifier: { colorFor: () => "#3178C6" },
  });
  value.cursor = { stage: "complete" };
  value.status = "ready";
  return value;
}

test("checkpoint decoder preserves JSON roundtrips and case-insensitive accounts", () => {
  for (const value of [checkpoint(), details(), completed()]) {
    assert.deepEqual(readCheckpoint(JSON.parse(JSON.stringify(value)), "Fixture-Alpha"), value);
  }
});

test("checkpoint decoder invalidates incompatible users and checkpoint/classifier versions", () => {
  const value = checkpoint();
  for (const changed of [
    { ...value, username: "fixture-beta" },
    { ...value, schemaVersion: 2 },
    { ...value, classifier: { ...value.classifier, version: 2 } },
    { ...value, classifier: { ...value.classifier, linguistVersion: "0.0.0" } },
  ]) {
    assert.equal(readCheckpoint(changed, value.username), null);
  }
});

test("checkpoint decoder validates embedded cache compatibility before reuse", () => {
  const value = completed();
  value.previous = value.result!.nextState;
  for (const field of ["previous", "result"] as const) {
    for (const replacement of [
      { ...value.result!.nextState, schemaVersion: 2 },
      { ...value.result!.nextState, username: "fixture-beta" },
      { ...value.result!.nextState, classifier: { version: 2, linguistVersion: LINGUIST_VERSION } },
      { ...value.result!.nextState, classifier: { version: CLASSIFIER_VERSION, linguistVersion: "old" } },
    ]) {
      const changed = field === "previous" ? { ...value, previous: replacement } : { ...value, result: { ...value.result, nextState: replacement } };
      assert.equal(readCheckpoint(changed, value.username), null);
    }
  }
  assert.equal(readCheckpoint({ ...value, result: { ...value.result, snapshot: { ...value.result!.snapshot, schemaVersion: 2 } } }, value.username), null);
});

test("checkpoint decoder rejects compatible corrupt metadata and progress", () => {
  const base = checkpoint();
  const corruptions: Array<(value: Record<string, unknown>) => void> = [
    (value) => { value.jobId = ""; },
    (value) => { value.period = { ...base.period, from: "2025-09-26T00:00:00.000Z" }; },
    (value) => { value.status = "ready"; },
    (value) => { value.status = "failed"; },
    (value) => { value.error = "unexpected"; },
    (value) => { value.attempt = -1; },
    (value) => { value.retry = { attempts: 4, nextAttemptAt: null }; },
    (value) => { value.retry = { attempts: 1, nextAttemptAt: "not-a-date" }; },
    (value) => { value.lease = { owner: "", expiresAt: "2026-09-27T00:01:00Z" }; },
    (value) => { value.nextRefreshAt = "2026-09-28T00:00:00Z"; },
    (value) => { value.cursor = { stage: "repositories", page: 0 }; },
    (value) => { value.cursor = { stage: "unknown" }; },
    (value) => { value.stateLoaded = "yes"; },
    (value) => { value.stateLoaded = true; },
    (value) => { value.profile = { publicRepositories: 0, stars: 0 }; },
    (value) => { value.previous = { schemaVersion: STATE_SCHEMA_VERSION }; },
  ];
  for (const corrupt of corruptions) {
    const value: Record<string, unknown> = structuredClone(base) as unknown as Record<string, unknown>;
    corrupt(value);
    assert.throws(() => readCheckpoint(value, base.username));
  }
});

test("checkpoint decoder rejects inconsistent completed prefixes and metrics", () => {
  const base = details();
  const corrupted = [
    { ...base, cursor: { stage: "details", index: 0, page: 1, filenames: [], fileCount: 0 } },
    { ...base, cursor: { stage: "details", index: 2, page: 1, filenames: [], fileCount: 0 } },
    { ...base, commits: {} },
    { ...base, commits: { bad: Object.values(base.commits)[0] } },
    { ...base, searched: [...base.searched, ...base.searched] },
    { ...base, metrics: { ...base.metrics, cacheHits: 1 } },
    { ...base, metrics: { ...base.metrics, searchedCommits: 0 } },
    { ...base, stateLoaded: false },
    { ...base, cursor: { stage: "details", index: 1, page: 2, filenames: ["one.ts"], fileCount: 1 } },
    { ...base, cursor: { stage: "details", index: 1, page: 31, filenames: [], fileCount: 3000 } },
  ];
  for (const value of corrupted) assert.throws(() => readCheckpoint(value, base.username));
});

test("checkpoint decoder accepts saved partial search and file pagination", () => {
  const value = details();
  value.cursor = {
    stage: "search", pending: [],
    current: { from: Date.parse(value.period.from), to: Date.parse(value.period.to), page: 2, totalCount: 200, commits: value.searched },
  };
  value.searched = [];
  value.commits = {};
  value.metrics = { searchedCommits: 0, fetchedCommits: 0, cacheHits: 0, removedCommits: 0 };
  value.retry = { attempts: 2, nextAttemptAt: "2026-09-27T00:00:30Z" };
  assert.deepEqual(readCheckpoint(value, value.username), value);

  const partial = details();
  partial.cursor = { stage: "details", index: 0, page: 2, fileCount: 100, filenames: ["src/main.ts"] };
  partial.commits = {};
  partial.metrics.fetchedCommits = 0;
  assert.deepEqual(readCheckpoint(partial, partial.username), partial);
});

test("checkpoint decoder rejects overlapping and out-of-period search intervals", () => {
  const value = details();
  value.commits = {};
  value.searched = [];
  value.metrics = { searchedCommits: 0, fetchedCommits: 0, cacheHits: 0, removedCommits: 0 };
  const from = Date.parse(value.period.from);
  const to = Date.parse(value.period.to);
  for (const cursor of [
    { stage: "search", pending: [{ from, to }, { from, to }], current: null },
    { stage: "search", pending: [{ from: from - 1000, to }], current: null },
    { stage: "search", pending: [], current: { from, to, page: 2, totalCount: null, commits: [] } },
    { stage: "search", pending: [], current: { from, to, page: 11, totalCount: 1000, commits: [] } },
    { stage: "search", pending: [], current: { from, to, page: 2, totalCount: 1001, commits: [] } },
  ]) assert.throws(() => readCheckpoint({ ...value, cursor }, value.username));
});

test("checkpoint decoder validates completed results against assembled data", () => {
  const base = completed();
  const changes: Array<(value: CollectionCheckpoint) => void> = [
    (value) => { value.result!.snapshot.stats.stars += 1; },
    (value) => { value.result!.snapshot.languages[0]!.commitCount += 1; },
    (value) => { value.result!.snapshot.generatedAt = value.period.from; },
    (value) => { value.result!.stateChanged = false; },
    (value) => { value.result!.nextState.commits = {}; },
    (value) => { value.result!.metrics.fetchedCommits = 0; },
    (value) => { value.retry.attempts = 1; },
    (value) => { value.lease = { owner: "old-worker", expiresAt: "2026-09-27T00:01:00Z" }; },
  ];
  for (const change of changes) {
    const value = structuredClone(base);
    change(value);
    assert.throws(() => readCheckpoint(value, base.username));
  }
});

test("checkpoint decoder rejects altered cache-hit languages", () => {
  const value = details();
  const state = completed().result!.nextState;
  value.previous = state;
  value.metrics.cacheHits = 1;
  value.metrics.fetchedCommits = 0;
  assert.deepEqual(readCheckpoint(value, value.username), value);
  Object.values(value.commits)[0]!.languages = ["Python"];
  assert.throws(() => readCheckpoint(value, value.username), /cached languages/);
});

test("checkpoint decoder rejects completed search commits inside unfinished intervals", () => {
  const value = details();
  value.cursor = {
    stage: "search",
    pending: [{ from: Date.parse(value.period.from), to: Date.parse(value.period.to) }],
    current: null,
  };
  value.commits = {};
  value.metrics.searchedCommits = 0;
  value.metrics.fetchedCommits = 0;
  assert.throws(() => readCheckpoint(value, value.username), /completed search intervals/);
});

test("pure state decoder rejects compatible corrupt caches and keeps unknown versions as misses", () => {
  const state = completed().result!.nextState;
  assert.deepEqual(parseState(state, "Fixture-Alpha"), { state, cacheUsable: true });
  assert.deepEqual(parseState({ ...state, schemaVersion: STATE_SCHEMA_VERSION + 1 }, state.username), { state: null, cacheUsable: false });
  assert.throws(() => parseState({ ...state, commits: { broken: Object.values(state.commits)[0] } }, state.username), /does not match/);
  assert.throws(() => parseState({ ...state, commits: { [Object.keys(state.commits)[0]!]: { ...Object.values(state.commits)[0], languages: ["TypeScript", "TypeScript"] } } }, state.username), /invalid shape/);
});
