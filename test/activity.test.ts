import assert from "node:assert/strict";
import test from "node:test";
import { aggregateActivity } from "../src/data/activity.js";
import type { CachedCommit } from "../src/model.js";

function commit(sha: string, authoredAt: string): CachedCommit {
  return {
    repositoryId: 1,
    repository: "fixture-org/activity-project",
    sha: sha.repeat(40),
    authoredAt,
    languages: [],
  };
}

test("aggregateActivity uses UTC midnight boundaries", () => {
  const activity = aggregateActivity(
    [commit("a", "2026-09-10T23:59:59.999Z"), commit("b", "2026-09-11T00:00:00.000Z")],
    "2026-09-10T00:00:00.000Z",
    "2026-09-11T23:59:59.999Z",
  );

  assert.deepEqual(activity, {
    timezone: "UTC",
    days: [
      { date: "2026-09-10", commits: 1 },
      { date: "2026-09-11", commits: 1 },
    ],
  });
});

test("aggregateActivity includes dates without commits", () => {
  const activity = aggregateActivity(
    [commit("a", "2026-09-10T12:00:00.000Z"), commit("b", "2026-09-12T12:00:00.000Z")],
    "2026-09-10T00:00:00.000Z",
    "2026-09-12T23:59:59.999Z",
  );

  assert.deepEqual(activity.days, [
    { date: "2026-09-10", commits: 1 },
    { date: "2026-09-11", commits: 0 },
    { date: "2026-09-12", commits: 1 },
  ]);
});

test("aggregateActivity rejects commits outside the collection period", () => {
  const from = "2026-09-10T00:00:00.000Z";
  const to = "2026-09-12T23:59:59.999Z";

  assert.throws(
    () => aggregateActivity([commit("a", "2026-09-09T23:59:59.999Z")], from, to),
    /outside the collection period/,
  );
  assert.throws(
    () => aggregateActivity([commit("b", "2026-09-13T00:00:00.000Z")], from, to),
    /outside the collection period/,
  );
});
