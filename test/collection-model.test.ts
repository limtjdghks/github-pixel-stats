import assert from "node:assert/strict";
import test from "node:test";
import { aggregateLanguages, collectionPeriod } from "../src/data/collection-model.js";
import type { CachedCommit } from "../src/model.js";

function commit(sha: string, languages: string[]): CachedCommit {
  return {
    repositoryId: 1,
    repository: "fixture/repository",
    sha,
    authoredAt: "2026-09-12T00:00:00Z",
    languages,
  };
}

test("collection period clamps a leap day and removes milliseconds", () => {
  const { now, from } = collectionPeriod(new Date("2024-02-29T12:34:56.987Z"));
  assert.equal(now.toISOString(), "2024-02-29T12:34:56.000Z");
  assert.equal(from.toISOString(), "2023-02-28T12:34:56.000Z");
});

test("language ranking counts each language once per commit and uses every language in the denominator", () => {
  const languages = aggregateLanguages([
    commit("a", ["A", "A", "B", "C", "D", "E", "F"]),
    commit("b", ["A"]),
  ], { colorFor: () => "#123456" });

  assert.deepEqual(languages.map(({ name, commitCount }) => [name, commitCount]), [
    ["A", 2], ["B", 1], ["C", 1], ["D", 1], ["E", 1],
  ]);
  assert.equal(languages[0]?.share, Number((2 / 7).toFixed(6)));
  assert.equal(languages[0]?.filledSegments, 3);
  assert.equal(languages[1]?.share, Number((1 / 7).toFixed(6)));
  assert.equal(languages[1]?.filledSegments, 1);
  assert.deepEqual(aggregateLanguages([], { colorFor: () => "#123456" }), []);
});
