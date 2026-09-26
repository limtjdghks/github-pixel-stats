import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectStats } from "../src/data/collect.js";
import { GitHubClient } from "../src/data/github-client.js";
import { loadUserFixture } from "./helpers/load-user-fixture.js";

test("collectStats uses GitHub login spelling and reuses same-user v1 cache", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gps-collect-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.json");
  const fixture = await loadUserFixture("fixture-alpha");
  await writeFile(path, JSON.stringify(fixture.state));
  let searchedUsername = "";
  t.mock.method(GitHubClient.prototype, "getProfileStats", async (username: string) => {
    assert.equal(username, "FIXTURE-ALPHA");
    return { login: "Fixture-Alpha", publicRepositories: 4, stars: 7 };
  });
  t.mock.method(GitHubClient.prototype, "searchCommits", async (username: string) => {
    searchedUsername = username;
    return fixture.githubResponses.searchCommits.expected;
  });
  t.mock.method(GitHubClient.prototype, "getCommitFilenames", async () => {
    throw new Error("A compatible cache must avoid commit detail requests.");
  });

  const result = await collectStats({
    username: "FIXTURE-ALPHA",
    token: "fixture-token",
    statePath: path,
    now: new Date("2026-09-12T23:59:59Z"),
  });

  assert.equal(searchedUsername, "Fixture-Alpha");
  assert.equal(result.snapshot.username, "Fixture-Alpha");
  assert.equal(result.nextState.username, "Fixture-Alpha");
  assert.equal(result.metrics.cacheHits, 3);
  assert.equal(result.metrics.fetchedCommits, 0);
  assert.equal(result.stateChanged, true);
});

test("collectStats does not reuse another user's cached commits", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gps-collect-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.json");
  const alpha = await loadUserFixture("fixture-alpha");
  const beta = await loadUserFixture("fixture-beta");
  await writeFile(path, JSON.stringify(alpha.state));
  t.mock.method(GitHubClient.prototype, "getProfileStats", async () => ({
    login: "fixture-beta",
    publicRepositories: 1,
    stars: 0,
  }));
  t.mock.method(GitHubClient.prototype, "searchCommits", async (username: string) => {
    assert.equal(username, "fixture-beta");
    return beta.githubResponses.searchCommits.expected;
  });
  let detailRequests = 0;
  t.mock.method(GitHubClient.prototype, "getCommitFilenames", async () => {
    detailRequests += 1;
    return beta.githubResponses.commitDetails.expectedFilenames;
  });

  const result = await collectStats({
    username: "fixture-beta",
    token: "fixture-token",
    statePath: path,
    now: new Date("2026-09-12T23:59:59Z"),
  });

  assert.equal(result.snapshot.username, "fixture-beta");
  assert.equal(result.nextState.username, "fixture-beta");
  assert.equal(result.metrics.cacheHits, 0);
  assert.equal(result.metrics.fetchedCommits, 1);
  assert.equal(detailRequests, 1);
});
