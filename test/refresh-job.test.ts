import assert from "node:assert/strict";
import test from "node:test";
import { GitHubRequestError } from "../src/data/github-pages.js";
import { REFRESH_INTERVAL_MS } from "../src/hosting/refresh-policy.js";
import { PUBLISH_RESERVE_MS, runRefreshJob } from "../src/hosting/refresh-job.js";
import { checkpointPathname } from "../src/storage/pathnames.js";
import { readManifest } from "../src/storage/private-repository.js";
import { REFRESH_NOW, refreshFixture } from "./helpers/refresh-fixture.js";

const HOUR = 60 * 60 * 1000;

function limits(now: number, overrides: { maxRequests?: number; resumeFailed?: boolean } = {}) {
  return { deadline: new Date(now + 60_000), maxRequests: 100, ...overrides };
}

test("first refresh collects and publishes in one job", async () => {
  const f = refreshFixture();
  const outcome = await runRefreshJob("Fixture-User", limits(REFRESH_NOW), f.dependencies);
  assert.deepEqual(outcome, { status: "ready", publish: "published", requests: f.calls.length, skippedCommits: 0, rateLimited: false });
  const stored = await readManifest(f.privateStore, "fixture-user");
  assert.equal(stored?.manifest.current.generatedAt, new Date(REFRESH_NOW).toISOString());
});

test("a refresh reports the commit details it skipped and still publishes", async () => {
  const f = refreshFixture();
  f.blockedDetails.add("fixture-user");
  const outcome = await runRefreshJob("fixture-user", limits(REFRESH_NOW), f.dependencies);
  assert.deepEqual(outcome, { status: "ready", publish: "published", requests: f.calls.length, skippedCommits: 2, rateLimited: false });
});

test("a ready but unpublished result is published before any new collection", async () => {
  const f = refreshFixture();
  const write = f.publicStore.write.bind(f.publicStore);
  f.publicStore.write = async () => { throw new Error("public store unavailable"); };
  await assert.rejects(runRefreshJob("fixture-user", limits(REFRESH_NOW), f.dependencies), /public store unavailable/);
  assert.equal(await readManifest(f.privateStore, "fixture-user"), null);
  const count = f.calls.length;

  f.publicStore.write = write;
  f.clock.now += REFRESH_INTERVAL_MS + HOUR;
  const outcome = await runRefreshJob("fixture-user", limits(f.clock.now), f.dependencies);
  // 저장된 결과를 먼저 발행한 뒤, 그 결과가 오래됐으므로 같은 실행에서 새 job으로 다시 수집해 발행합니다.
  assert.equal(outcome.publish, "published");
  const stored = await readManifest(f.privateStore, "fixture-user");
  assert.equal(stored?.manifest.previous?.generatedAt, new Date(REFRESH_NOW).toISOString());
  assert.equal(stored?.manifest.current.generatedAt, new Date(f.clock.now).toISOString());
  assert.ok(f.calls.length > count);
});

test("a fresh published result is not collected again", async () => {
  const f = refreshFixture();
  await runRefreshJob("fixture-user", limits(REFRESH_NOW), f.dependencies);
  const count = f.calls.length;
  f.clock.now += REFRESH_INTERVAL_MS - 1;
  const outcome = await runRefreshJob("fixture-user", limits(f.clock.now), f.dependencies);
  assert.deepEqual(outcome, { status: "ready", publish: "unchanged", requests: 0, skippedCommits: 0, rateLimited: false });
  assert.equal(f.calls.length, count);
});

test("concurrent jobs for one user collect once and advance the manifest once", async () => {
  const f = refreshFixture();
  const [left, right] = await Promise.all([
    runRefreshJob("fixture-user", limits(REFRESH_NOW), f.dependencies),
    runRefreshJob("fixture-user", limits(REFRESH_NOW), f.dependencies),
  ]);
  assert.deepEqual([left.status, right.status].sort(), ["conflict", "ready"]);
  assert.equal(f.calls.filter((request) => request.kind === "profile").length, 1);
  const stored = await readManifest(f.privateStore, "fixture-user");
  assert.equal(stored?.manifest.previous, null);
});

test("an active lease makes another job return busy without GitHub requests", async () => {
  const f = refreshFixture();
  await runRefreshJob("fixture-user", limits(REFRESH_NOW, { maxRequests: 1 }), f.dependencies);
  const pathname = checkpointPathname("fixture-user");
  const stored = JSON.parse(f.privateStore.objects.get(pathname)!.body) as { status: string; lease: unknown };
  stored.status = "collecting";
  stored.lease = { owner: "other", expiresAt: new Date(REFRESH_NOW + 30_000).toISOString() };
  f.privateStore.objects.get(pathname)!.body = JSON.stringify(stored);
  const count = f.calls.length;
  const outcome = await runRefreshJob("fixture-user", limits(REFRESH_NOW), f.dependencies);
  assert.equal(outcome.status, "busy");
  assert.equal(f.calls.length, count);
});

test("resumeFailed false leaves a failed collection without GitHub requests", async () => {
  const f = refreshFixture();
  f.missing.add("ghost");
  assert.equal((await runRefreshJob("ghost", limits(REFRESH_NOW), f.dependencies)).status, "failed");
  const count = f.calls.length;
  const outcome = await runRefreshJob("ghost", limits(REFRESH_NOW, { resumeFailed: false }), f.dependencies);
  assert.deepEqual(outcome, { status: "failed", publish: null, requests: 0, skippedCommits: 0, rateLimited: false });
  assert.equal(f.calls.length, count);
});

test("the batch stops early enough to leave time for publishing", async () => {
  const f = refreshFixture();
  const outcome = await runRefreshJob("fixture-user", {
    deadline: new Date(REFRESH_NOW + PUBLISH_RESERVE_MS), maxRequests: 100,
  }, f.dependencies);
  assert.deepEqual(outcome, { status: "paused", publish: null, requests: 0, skippedCommits: 0, rateLimited: false });
  assert.equal(f.calls.length, 0);
});

test("a manifest conflict keeps the last published manifest", async () => {
  const f = refreshFixture();
  await runRefreshJob("fixture-user", limits(REFRESH_NOW), f.dependencies);
  f.clock.now += REFRESH_INTERVAL_MS + HOUR;
  const before = await readManifest(f.privateStore, "fixture-user");
  const write = f.privateStore.write.bind(f.privateStore);
  f.privateStore.write = async (pathname, body, options) =>
    pathname.startsWith("manifests/") ? null : write(pathname, body, options);
  const outcome = await runRefreshJob("fixture-user", limits(f.clock.now), f.dependencies);
  assert.equal(outcome.publish, "conflict");
  f.privateStore.write = write;
  assert.deepEqual(await readManifest(f.privateStore, "fixture-user"), before);
});

test("a past retry time left on the checkpoint is not reported as a rate limit", async () => {
  const f = refreshFixture();
  const request = f.dependencies.github.requestPage;
  f.dependencies.github.requestPage = async () => { throw new GitHubRequestError("GitHub API 502", null, 502); };
  const failed = await runRefreshJob("fixture-user", limits(REFRESH_NOW), f.dependencies);
  assert.deepEqual([failed.status, failed.rateLimited], ["paused", false]);

  // backoff가 지난 뒤 재개한 batch가 첫 요청이 끝나기 전에 deadline으로 멈추는 상황입니다.
  f.clock.now += 60_000;
  // job deadline 60초에서 발행 여유 5초와 checkpoint 여유 1초를 뺀 수집 마감 직후, lease 만료 전으로 시계를 옮깁니다.
  f.dependencies.github.requestPage = async (page, signal) => {
    f.clock.now += 54_500;
    return request(page, signal);
  };
  const resumed = await runRefreshJob("fixture-user", limits(f.clock.now), f.dependencies);
  assert.equal(resumed.status, "paused");
  assert.equal(resumed.rateLimited, false);
});

test("a rate-limited batch is reported so callers can stop using the same token", async () => {
  const f = refreshFixture();
  f.dependencies.github.requestPage = async () => { throw new GitHubRequestError("rate limited", 30 * 60_000, 403); };
  const outcome = await runRefreshJob("fixture-user", limits(REFRESH_NOW), f.dependencies);
  assert.deepEqual(outcome, { status: "paused", publish: null, requests: 1, skippedCommits: 0, rateLimited: true });
});
