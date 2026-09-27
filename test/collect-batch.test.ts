import assert from "node:assert/strict";
import test from "node:test";
import { collectStats } from "../src/data/collect.js";
import { collectStatsBatch } from "../src/data/collect-batch.js";
import type { BatchDependencies, BatchOptions, BatchResult, CollectionCheckpoint } from "../src/data/checkpoint-model.js";
import type { LanguageClassifier } from "../src/data/collection-ports.js";
import { GitHubRequestError, type PageRequest, type PageResult } from "../src/data/github-pages.js";
import type { CollectorState, SearchCommit } from "../src/model.js";
import { MemoryCheckpointStore } from "./helpers/memory-checkpoint-store.js";

const NOW = Date.parse("2026-09-12T23:59:59.000Z");
const classifier: LanguageClassifier = {
  classifyFiles: (paths) => [...new Set(paths.map((path) => path.endsWith(".ts") ? "TypeScript" : "Python"))].sort(),
  colorFor: () => "#123456",
};

function commits(count: number): SearchCommit[] {
  return Array.from({ length: count }, (_, index) => ({
    repositoryId: 1,
    repository: "fixture/repo",
    sha: (index + 1).toString(16).padStart(40, "0"),
    authoredAt: new Date(NOW - (count - index) * 60_000).toISOString(),
  }));
}

function fixture(count = 1, state: CollectorState | null = null) {
  const searched = commits(count);
  const calls: PageRequest[] = [];
  const clock = { now: NOW };
  let serial = 0;
  let store = new MemoryCheckpointStore();
  const page = (request: PageRequest): PageResult => {
    switch (request.kind) {
      case "profile": return { kind: "profile", login: "Fixture", publicRepositories: 2 };
      case "repositories": return { kind: "repositories", stars: request.page === 1 ? 3 : 4, hasNext: request.page === 1 };
      case "search": {
        const found = searched.filter((commit) => Date.parse(commit.authoredAt) >= request.from && Date.parse(commit.authoredAt) <= request.to);
        return { kind: "search", commits: found.slice((request.page - 1) * 100, request.page * 100),
          totalCount: found.length, incomplete: false, hasNext: request.page * 100 < found.length };
      }
      case "files": return { kind: "files", filenames: ["src/main.ts", "src/other.ts"], fileCount: 2, hasNext: false };
    }
  };
  const dependencies: BatchDependencies = {
    github: { async requestPage(request, signal) { signal.throwIfAborted(); calls.push(structuredClone(request)); return page(request); } },
    checkpoints: store,
    loadClassifier: async () => classifier,
    loadState: async () => ({ state, cacheUsable: state !== null }),
    now: () => new Date(clock.now),
    newId: () => `id-${++serial}`,
  };
  return {
    searched, calls, clock, dependencies, page,
    get store() { return store; },
    restart() { store = MemoryCheckpointStore.restore(store.export()); dependencies.checkpoints = store; },
    options(overrides: Partial<BatchOptions> = {}): BatchOptions {
      return { username: "FIXTURE", deadline: new Date(clock.now + 60_000), checkpointReserveMs: 1_000, maxRequests: 1_000, ...overrides };
    },
  };
}

async function finish(f: ReturnType<typeof fixture>, maxRequests = 1): Promise<BatchResult> {
  for (let batch = 0; batch < 1_500; batch++) {
    const result = await collectStatsBatch(f.options({ maxRequests }), f.dependencies);
    assert.ok(result.requests <= maxRequests);
    if (result.status === "ready") return result;
    assert.equal(result.status, "paused");
    assert.equal(result.result, null);
    f.restart();
    f.clock.now += 1_000;
  }
  throw new Error("Collection did not complete within the batch limit.");
}

test("700 commits produce the same complete result in one run, JSON-restored batches, and legacy collection", async () => {
  const single = fixture(700);
  const one = await collectStatsBatch(single.options(), single.dependencies);
  assert.equal(one.status, "ready");
  const resumed = fixture(700);
  const many = await finish(resumed, 31);
  const legacy = await collectStats({ username: "FIXTURE" }, {
    now: () => new Date(NOW),
    loadClassifier: async () => classifier,
    loadState: async () => ({ state: null, cacheUsable: false }),
    github: {
      getProfileStats: async () => ({ login: "Fixture", publicRepositories: 2, stars: 7 }),
      searchCommits: async () => single.searched,
      getCommitFilenames: async () => ["src/main.ts", "src/other.ts"],
    },
  });
  assert.deepEqual(one.result, legacy);
  assert.deepEqual(many.result, legacy);
  assert.equal(resumed.calls.length, 710);
  assert.equal(new Set(resumed.calls.map((call) => JSON.stringify(call))).size, 710);
  assert.equal(many.checkpoint?.nextRefreshAt, null);
});

test("one-request batches preserve profile, repository, search, and partial file pages", async () => {
  const f = fixture();
  f.dependencies.github.requestPage = async (request) => {
    f.calls.push(structuredClone(request));
    return request.kind === "files"
      ? { kind: "files", filenames: [request.page === 1 ? "src/main.ts" : "src/main.py"], fileCount: 1, hasNext: request.page === 1 }
      : f.page(request);
  };
  const result = await finish(f);
  assert.equal(result.status, "ready");
  assert.deepEqual(result.result?.nextState.commits[`1:${f.searched[0]!.sha}`]?.languages, ["Python", "TypeScript"]);
  assert.deepEqual(f.calls.map((request) => request.kind === "profile" ? "profile" : `${request.kind}:${request.page}`),
    ["profile", "repositories:1", "repositories:2", "search:1", "files:1", "files:2"]);
  assert.equal(result.result?.snapshot.stats.stars, 7);
});

test("completed checkpoint returns the saved result without HTTP or state loading", async () => {
  const f = fixture();
  const first = await finish(f);
  const count = f.calls.length;
  f.dependencies.loadState = async () => { throw new Error("unexpected state load"); };
  const result = await collectStatsBatch(f.options(), f.dependencies);
  assert.equal(result.status, "ready");
  assert.equal(result.requests, 0);
  assert.equal(f.calls.length, count);
  assert.deepEqual(result.result, first.result);
});

test("zero request budget persists a resumable pending checkpoint without HTTP", async () => {
  const f = fixture();
  const result = await collectStatsBatch(f.options({ maxRequests: 0 }), f.dependencies);
  assert.equal(result.status, "paused");
  assert.equal(result.requests, 0);
  assert.equal(result.checkpoint?.cursor.stage, "profile");
  assert.equal(f.calls.length, 0);
  assert.equal((await finish(f)).status, "ready");
});

test("expired deadline returns before loading the checkpoint or calling GitHub", async () => {
  const f = fixture();
  f.dependencies.checkpoints.load = async () => { throw new Error("unexpected load"); };
  const result = await collectStatsBatch(f.options({ deadline: new Date(NOW - 1) }), f.dependencies);
  assert.equal(result.status, "paused");
  assert.equal(result.checkpoint, null);
  assert.equal(f.calls.length, 0);
});

test("concurrent invocation sees an active lease and performs no HTTP", async () => {
  const f = fixture();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  f.dependencies.github.requestPage = async (request) => {
    f.calls.push(structuredClone(request));
    entered();
    await blocked;
    return f.page(request);
  };
  const first = collectStatsBatch(f.options({ maxRequests: 1 }), f.dependencies);
  await started;
  const other = await collectStatsBatch(f.options(), f.dependencies);
  assert.equal(other.status, "busy");
  assert.equal(other.requests, 0);
  assert.equal(f.calls.length, 1);
  release();
  assert.equal((await first).status, "paused");
});

test("lease expiry permits takeover and prevents an old request from saving late", async () => {
  const f = fixture();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let initial = true;
  f.dependencies.github.requestPage = async (request) => {
    f.calls.push(structuredClone(request));
    if (initial) {
      initial = false;
      entered();
      await blocked;
    }
    return f.page(request);
  };
  const old = collectStatsBatch(f.options({ maxRequests: 1 }), f.dependencies);
  await started;
  f.clock.now += 61_000;
  const fresh = await collectStatsBatch(f.options(), f.dependencies);
  assert.equal(fresh.status, "ready");
  assert.equal(fresh.checkpoint?.attempt, 2);
  release();
  assert.equal((await old).status, "conflict");
  assert.deepEqual((await collectStatsBatch(f.options(), f.dependencies)).result, fresh.result);
});

test("simultaneous initial callers acquire only one lease", async () => {
  const f = fixture();
  const results = await Promise.all([
    collectStatsBatch(f.options({ maxRequests: 1 }), f.dependencies),
    collectStatsBatch(f.options({ maxRequests: 1 }), f.dependencies),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["conflict", "paused"]);
  assert.equal(f.calls.length, 1);
});

test("a failed ready write never publishes an unpersisted result and can resume", async () => {
  const f = fixture();
  const base = f.store;
  f.dependencies.checkpoints = {
    load: base.load.bind(base),
    compareAndSwap: async (...args) => {
      if (args[2].status === "ready") throw new Error("ready write failed");
      return base.compareAndSwap(...args);
    },
  };
  await assert.rejects(collectStatsBatch(f.options(), f.dependencies), /ready write failed/);
  const saved = (await base.load("fixture", new AbortController().signal))!.value as CollectionCheckpoint;
  assert.notEqual(saved.status, "ready");
  assert.equal(saved.result, null);
  const count = f.calls.length;
  f.dependencies.checkpoints = base;
  f.clock.now += 61_000;
  const resumed = await collectStatsBatch(f.options(), f.dependencies);
  assert.equal(resumed.status, "ready");
  assert.equal(f.calls.length, count);
});

test("storage write failure is rejected without reporting collection success", async () => {
  const f = fixture();
  const base = f.store;
  let saves = 0;
  f.dependencies.checkpoints = {
    load: base.load.bind(base),
    compareAndSwap: async (...args) => {
      saves++;
      if (saves === 2) throw new Error("storage unavailable");
      return base.compareAndSwap(...args);
    },
  };
  await assert.rejects(collectStatsBatch(f.options(), f.dependencies), /storage unavailable/);
});

test("failed API request resumes explicitly without repeating saved pages", async () => {
  const f = fixture(2);
  let fail = true;
  f.dependencies.github.requestPage = async (request) => {
    f.calls.push(structuredClone(request));
    if (request.kind === "files" && request.sha === f.searched[1]!.sha && fail) throw new Error("detail unavailable");
    return f.page(request);
  };
  const failed = await collectStatsBatch(f.options(), f.dependencies);
  assert.equal(failed.status, "failed");
  assert.equal(failed.checkpoint?.metrics.fetchedCommits, 1);
  assert.equal(failed.result, null);
  fail = false;
  f.restart();
  const done = await finish(f);
  assert.equal(done.result?.metrics.fetchedCommits, 2);
  assert.equal(f.calls.filter((request) => request.kind === "profile").length, 1);
  assert.equal(f.calls.filter((request) => request.kind === "files" && request.sha === f.searched[0]!.sha).length, 1);
});

test("rate-limit retry schedule survives JSON restart and each retry consumes a request", async () => {
  const f = fixture();
  let retries = 0;
  f.dependencies.github.requestPage = async (request) => {
    f.calls.push(structuredClone(request));
    if (retries++ < 1) throw new GitHubRequestError("rate limited", 2_000);
    return f.page(request);
  };
  const first = await collectStatsBatch(f.options({ maxRequests: 1 }), f.dependencies);
  assert.equal(first.status, "paused");
  assert.equal(first.requests, 1);
  assert.equal(first.checkpoint?.retry.attempts, 1);
  assert.equal(first.checkpoint?.retry.nextAttemptAt, new Date(NOW + 2_000).toISOString());
  f.restart();
  const early = await collectStatsBatch(f.options(), f.dependencies);
  assert.equal(early.status, "paused");
  assert.equal(early.requests, 0);
  assert.equal(f.calls.length, 1);
  f.clock.now += 2_000;
  const second = await collectStatsBatch(f.options({ maxRequests: 1 }), f.dependencies);
  assert.equal(second.requests, 1);
  assert.equal(second.checkpoint?.retry.attempts, 0);
  assert.equal(second.checkpoint?.cursor.stage, "repositories");
});

test("rate-limit failures exhaust three retries across invocations", async () => {
  const f = fixture();
  f.dependencies.github.requestPage = async () => { throw new GitHubRequestError("rate limited", 1_000); };
  for (let attempt = 0; attempt < 4; attempt++) {
    const result = await collectStatsBatch(f.options({ maxRequests: 1 }), f.dependencies);
    assert.equal(result.requests, 1);
    assert.equal(result.status, attempt === 3 ? "failed" : "paused");
    if (attempt < 3) assert.equal(result.checkpoint?.retry.attempts, attempt + 1);
    f.restart();
    f.clock.now += 1_000;
  }
});

test("excessive rate-limit delay fails rather than scheduling a long retry", async () => {
  const f = fixture();
  f.dependencies.github.requestPage = async () => { throw new GitHubRequestError("rate limited", 60_001); };
  const result = await collectStatsBatch(f.options(), f.dependencies);
  assert.equal(result.status, "failed");
  assert.equal(result.requests, 1);
});

test("deadline aborts an in-flight request and preserves its cursor", async () => {
  const f = fixture();
  let aborted = false;
  f.dependencies.now = () => new Date();
  f.dependencies.github.requestPage = async (_request, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
  });
  const result = await collectStatsBatch(f.options({ deadline: new Date(Date.now() + 150), checkpointReserveMs: 75 }), f.dependencies);
  assert.equal(aborted, true);
  assert.equal(result.status, "paused");
  assert.equal(result.requests, 1);
  assert.equal(result.checkpoint?.cursor.stage, "profile");
  assert.equal(result.checkpoint?.metrics.fetchedCommits, 0);
});

test("new-commit budget stops before uncached files and allows cached commits", async () => {
  const initial = fixture(3);
  const baseline = await collectStatsBatch(initial.options(), initial.dependencies);
  const state = structuredClone(baseline.result!.nextState);
  delete state.commits[`1:${initial.searched[1]!.sha}`];
  const f = fixture(3, state);
  const paused = await collectStatsBatch(f.options({ maxNewCommits: 0 }), f.dependencies);
  assert.equal(paused.status, "paused");
  assert.equal(paused.checkpoint?.metrics.cacheHits, 1);
  assert.equal(f.calls.filter((request) => request.kind === "files").length, 0);
  const done = await collectStatsBatch(f.options({ maxNewCommits: 1 }), f.dependencies);
  assert.equal(done.status, "ready");
  assert.equal(done.result?.metrics.cacheHits, 2);
  assert.equal(done.result?.metrics.fetchedCommits, 1);
});

test("new-commit budget is reset for the next batch", async () => {
  const f = fixture(3);
  for (let index = 1; index <= 3; index++) {
    const result = await collectStatsBatch(f.options({ maxNewCommits: 1 }), f.dependencies);
    assert.equal(result.checkpoint?.metrics.fetchedCommits, index);
    assert.equal(result.status, index === 3 ? "ready" : "paused");
    f.restart();
  }
});

test("three thousand accumulated files fail without classifying a truncated commit", async () => {
  const f = fixture();
  f.dependencies.github.requestPage = async (request) => {
    f.calls.push(structuredClone(request));
    return request.kind === "files"
      ? { kind: "files", filenames: Array.from({ length: 100 }, (_, i) => `src/${request.page}-${i}.ts`),
        fileCount: 100, hasNext: request.page < 30 }
      : f.page(request);
  };
  let result: BatchResult | undefined;
  for (let batch = 0; batch < 40; batch++) {
    result = await collectStatsBatch(f.options({ maxRequests: 1 }), f.dependencies);
    if (result.status === "failed") break;
    assert.equal(result.status, "paused");
    f.restart();
  }
  assert.equal(result?.status, "failed");
  assert.match(result?.checkpoint?.error ?? "", /3,000/);
  assert.equal(result?.checkpoint?.metrics.fetchedCommits, 0);
  assert.equal(Object.keys(result?.checkpoint?.commits ?? {}).length, 0);
  assert.equal(f.calls.filter((request) => request.kind === "files").length, 30);
});

test("incomplete search splits intervals and discards partial parent results", async () => {
  const f = fixture(2);
  let searches = 0;
  f.dependencies.github.requestPage = async (request) => {
    f.calls.push(structuredClone(request));
    if (request.kind === "search") {
      searches++;
      if (searches === 1) return { kind: "search", totalCount: 2, incomplete: false, commits: [f.searched[0]!], hasNext: true };
      if (searches === 2) return { kind: "search", totalCount: 2, incomplete: true, commits: [f.searched[1]!], hasNext: false };
    }
    return f.page(request);
  };
  const result = await finish(f);
  assert.equal(result.result?.snapshot.stats.commits, 2);
  assert.equal(result.result?.metrics.fetchedCommits, 2);
  assert.equal(f.calls.filter((request) => request.kind === "files").length, 2);
  assert.ok(searches >= 4);
});

test("duplicate search pages trigger a fresh subdivision without duplicate commits", async () => {
  const f = fixture(2);
  let searches = 0;
  f.dependencies.github.requestPage = async (request) => {
    f.calls.push(structuredClone(request));
    if (request.kind === "search" && ++searches <= 2) {
      return { kind: "search", totalCount: 2, incomplete: false, commits: [f.searched[0]!], hasNext: searches === 1 };
    }
    return f.page(request);
  };
  const result = await finish(f);
  assert.equal(result.result?.snapshot.stats.commits, 2);
  assert.equal(result.result?.metrics.searchedCommits, 2);
});

test("search pagination beyond page ten subdivides before saving an invalid cursor", async () => {
  const f = fixture(10);
  let originalRange: { from: number; to: number } | undefined;
  f.dependencies.github.requestPage = async (request) => {
    f.calls.push(structuredClone(request));
    if (request.kind === "search") {
      originalRange ??= { from: request.from, to: request.to };
      if (request.from === originalRange.from && request.to === originalRange.to) {
        return { kind: "search", totalCount: 10, incomplete: false,
          commits: [f.searched[request.page - 1]!], hasNext: true };
      }
    }
    return f.page(request);
  };
  const result = await finish(f);
  assert.equal(result.result?.snapshot.stats.commits, 10);
  assert.equal(result.result?.metrics.fetchedCommits, 10);
  const originalPages = f.calls.filter((request) => request.kind === "search" &&
    request.from === originalRange?.from && request.to === originalRange?.to);
  assert.deepEqual(originalPages.map((request) => request.kind === "search" ? request.page : 0),
    Array.from({ length: 10 }, (_, index) => index + 1));
  assert.equal(f.calls.filter((request) => request.kind === "files").length, 10);
});

test("file pagination beyond page thirty fails with a valid checkpoint that can resume", async () => {
  const f = fixture();
  let incomplete = true;
  f.dependencies.github.requestPage = async (request) => {
    f.calls.push(structuredClone(request));
    return request.kind === "files"
      ? { kind: "files", filenames: [`src/page-${request.page}.ts`], fileCount: 1,
        hasNext: request.page < 30 || incomplete }
      : f.page(request);
  };
  let failed: BatchResult | undefined;
  for (let batch = 0; batch < 40; batch++) {
    failed = await collectStatsBatch(f.options({ maxRequests: 1 }), f.dependencies);
    f.restart();
    if (failed.status === "failed") break;
    assert.equal(failed.status, "paused");
  }
  assert.equal(failed?.status, "failed");
  assert.match(failed?.checkpoint?.error ?? "", /incomplete file pagination/);
  assert.deepEqual(failed?.checkpoint?.cursor, {
    stage: "details", index: 0, page: 30, fileCount: 29,
    filenames: Array.from({ length: 29 }, (_, index) => `src/page-${index + 1}.ts`),
  });
  assert.equal(failed?.checkpoint?.metrics.fetchedCommits, 0);
  incomplete = false;
  const resumed = await finish(f);
  assert.equal(resumed.result?.metrics.fetchedCommits, 1);
  const filePages = f.calls.filter((request) => request.kind === "files");
  assert.deepEqual(filePages.map((request) => request.kind === "files" ? request.page : 0),
    [...Array.from({ length: 30 }, (_, index) => index + 1), 30]);
});

test("search total count shortage without duplicate commits subdivides and recovers after JSON restart", async () => {
  const f = fixture(2);
  let initial = true;
  f.dependencies.github.requestPage = async (request) => {
    f.calls.push(structuredClone(request));
    if (request.kind === "search" && initial) {
      initial = false;
      return { kind: "search", totalCount: 2, incomplete: false,
        commits: [f.searched[0]!], hasNext: false };
    }
    return f.page(request);
  };
  const result = await finish(f);
  assert.equal(result.result?.snapshot.stats.commits, 2);
  assert.equal(result.result?.metrics.searchedCommits, 2);
  assert.equal(f.calls.filter((request) => request.kind === "search").length, 3);
  assert.equal(f.calls.filter((request) => request.kind === "files").length, 2);
});

for (const mismatch of ["schema", "classifier", "username"] as const) {
  test(`incompatible ${mismatch} checkpoint is conditionally replaced`, async () => {
    const f = fixture();
    const first = await collectStatsBatch(f.options({ maxRequests: 1 }), f.dependencies);
    const oldId = first.checkpoint?.jobId;
    f.store.rewrite((checkpoint) => mismatch === "schema" ? { ...checkpoint, schemaVersion: 9 }
      : mismatch === "classifier" ? { ...checkpoint, classifier: { version: 99, linguistVersion: "future" } }
      : { ...checkpoint, username: "Other" });
    const result = await finish(f);
    assert.notEqual(result.checkpoint?.jobId, oldId);
    assert.equal(f.calls.filter((request) => request.kind === "profile").length, 2);
  });
}

test("corrupt compatible checkpoint is rejected instead of silently resetting", async () => {
  const f = fixture();
  await collectStatsBatch(f.options({ maxRequests: 1 }), f.dependencies);
  f.store.rewrite((checkpoint) => ({ ...checkpoint, cursor: { stage: "invalid" } }));
  await assert.rejects(collectStatsBatch(f.options(), f.dependencies), /checkpoint|cursor/i);
});

test("CAS collision does not invoke GitHub", async () => {
  const f = fixture();
  f.dependencies.checkpoints.compareAndSwap = async () => null;
  const result = await collectStatsBatch(f.options(), f.dependencies);
  assert.equal(result.status, "conflict");
  assert.equal(result.requests, 0);
  assert.equal(f.calls.length, 0);
});

test("memory checkpoint store serializes values and enforces revision, owner, expiration, and cancellation", async () => {
  const f = fixture();
  await collectStatsBatch(f.options({ maxRequests: 0 }), f.dependencies);
  const signal = new AbortController().signal;
  const loaded = await f.store.load("fixture", signal);
  assert.ok(loaded);
  const checkpoint = loaded.value as CollectionCheckpoint;
  checkpoint.lease = { owner: "owner", expiresAt: new Date(NOW + 1_000).toISOString() };
  const revision = await f.store.compareAndSwap("fixture", loaded.revision, checkpoint, null, signal);
  assert.ok(revision);
  checkpoint.error = "local mutation";
  assert.equal(((await f.store.load("fixture", signal))!.value as CollectionCheckpoint).error, null);
  assert.equal(await f.store.compareAndSwap("fixture", loaded.revision, checkpoint, null, signal), null);
  assert.equal(await f.store.compareAndSwap("fixture", revision, checkpoint, { owner: "wrong", now: new Date(NOW).toISOString() }, signal), null);
  assert.equal(await f.store.compareAndSwap("fixture", revision, checkpoint, { owner: "owner", now: new Date(NOW + 1_000).toISOString() }, signal), null);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.store.load("fixture", controller.signal));
  await assert.rejects(f.store.compareAndSwap("fixture", revision, checkpoint, null, controller.signal));
});

test("invalid batch request and commit limits reject before any HTTP", async () => {
  const f = fixture();
  for (const overrides of [{ maxRequests: -1 }, { maxRequests: 1.5 }, { maxNewCommits: -1 }, { checkpointReserveMs: 0 }]) {
    await assert.rejects(collectStatsBatch(f.options(overrides), f.dependencies));
  }
  assert.equal(f.calls.length, 0);
});
