import assert from "node:assert/strict";
import test from "node:test";
import { CollectionFailure, collectStats } from "../src/data/collect.js";
import type { CollectionDependencies } from "../src/data/collection-ports.js";
import type { CollectorState, SearchCommit } from "../src/model.js";
import { loadUserFixture } from "./helpers/load-user-fixture.js";

const NOW = new Date("2026-09-12T23:59:59.987Z");

function fakeDependencies(options: {
  login: string;
  searched: SearchCommit[];
  state: CollectorState | null;
  cacheUsable?: boolean;
  languages?: string[];
  filenames?: string[];
  failDetail?: boolean;
}) {
  const calls = { profile: [] as string[], state: [] as string[], search: [] as string[], detail: [] as string[] };
  const dependencies: CollectionDependencies = {
    github: {
      async getProfileStats(username) {
        calls.profile.push(username);
        return { login: options.login, publicRepositories: 4, stars: 7 };
      },
      async searchCommits(username, from, to) {
        calls.search.push(username);
        assert.equal(from.toISOString(), "2025-09-12T23:59:59.000Z");
        assert.equal(to.toISOString(), "2026-09-12T23:59:59.000Z");
        return options.searched;
      },
      async getCommitFilenames(repository, sha) {
        calls.detail.push(`${repository}@${sha}`);
        if (options.failDetail) {
          throw new Error("detail failed");
        }
        return options.filenames ?? [];
      },
    },
    async loadState(username) {
      calls.state.push(username);
      return { state: options.state, cacheUsable: options.cacheUsable ?? options.state !== null };
    },
    async loadClassifier() {
      return {
        classifyFiles: () => options.languages ?? [],
        colorFor: () => "#123456",
      };
    },
    now: () => NOW,
  };
  return { dependencies, calls };
}

test("collector uses canonical login and reuses matching cache without I/O", async () => {
  const { state, githubResponses } = await loadUserFixture("fixture-alpha");
  const { dependencies, calls } = fakeDependencies({
    login: "Fixture-Alpha",
    searched: githubResponses.searchCommits.expected,
    state,
  });

  const result = await collectStats({ username: "FIXTURE-ALPHA" }, dependencies);

  assert.deepEqual(calls, {
    profile: ["FIXTURE-ALPHA"],
    state: ["Fixture-Alpha"],
    search: ["Fixture-Alpha"],
    detail: [],
  });
  assert.equal(result.snapshot.username, "Fixture-Alpha");
  assert.equal(result.snapshot.generatedAt, "2026-09-12T23:59:59.000Z");
  assert.deepEqual(result.snapshot.stats, { commits: 3, publicRepositories: 4, stars: 7 });
  assert.deepEqual(result.metrics, { searchedCommits: 3, cacheHits: 3, fetchedCommits: 0, removedCommits: 0 });
  assert.equal(result.stateChanged, true);
  assert.equal(result.snapshot.languages[0]?.name, "TypeScript");
  assert.equal(result.snapshot.languages[0]?.commitCount, 3);
});

test("collector fetches another user's commit and does not reuse the previous account's cache", async () => {
  const alpha = await loadUserFixture("fixture-alpha");
  const beta = await loadUserFixture("fixture-beta");
  const { dependencies, calls } = fakeDependencies({
    login: "fixture-beta",
    searched: beta.githubResponses.searchCommits.expected,
    state: alpha.state,
    cacheUsable: false,
    filenames: beta.githubResponses.commitDetails.expectedFilenames,
  });

  const result = await collectStats({ username: "fixture-beta" }, dependencies);

  assert.deepEqual(calls.state, ["fixture-beta"]);
  assert.equal(calls.detail.length, 1);
  assert.deepEqual(result.metrics, { searchedCommits: 1, cacheHits: 0, fetchedCommits: 1, removedCommits: 0 });
  assert.deepEqual(result.snapshot.languages, []);
  assert.equal(result.nextState.username, "fixture-beta");
});

test("collector preserves unchanged state time and counts removed commits", async () => {
  const { state, githubResponses } = await loadUserFixture("fixture-alpha");
  const same = fakeDependencies({ login: "fixture-alpha", searched: githubResponses.searchCommits.expected, state });
  const unchanged = await collectStats({ username: "fixture-alpha" }, same.dependencies);
  assert.equal(unchanged.stateChanged, false);
  assert.equal(unchanged.nextState.updatedAt, state.updatedAt);

  const withoutOne = fakeDependencies({
    login: "fixture-alpha",
    searched: githubResponses.searchCommits.expected.slice(0, 2),
    state,
  });
  const changed = await collectStats({ username: "fixture-alpha" }, withoutOne.dependencies);
  assert.equal(changed.metrics.removedCommits, 1);
  assert.equal(changed.stateChanged, true);
  assert.equal(changed.nextState.updatedAt, "2026-09-12T23:59:59.000Z");
  assert.equal(Object.keys(changed.nextState.commits).length, 2);
});

test("collector failure retains completed metrics and cause", async () => {
  const { githubResponses } = await loadUserFixture("fixture-beta");
  const { dependencies } = fakeDependencies({
    login: "fixture-beta",
    searched: githubResponses.searchCommits.expected,
    state: null,
    failDetail: true,
  });

  await assert.rejects(
    collectStats({ username: "fixture-beta" }, dependencies),
    (error: unknown) => {
      assert.ok(error instanceof CollectionFailure);
      assert.equal(error.message, "detail failed");
      assert.equal((error.cause as Error).message, "detail failed");
      assert.deepEqual(error.metrics, { searchedCommits: 1, cacheHits: 0, fetchedCommits: 0, removedCommits: 0 });
      return true;
    },
  );
});
