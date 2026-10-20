import assert from "node:assert/strict";
import test from "node:test";
import { cronResponse } from "../src/hosting/cron-response.js";
import { CRON_MIN_USER_BUDGET_MS, runCron, type CronLimits } from "../src/hosting/cron-run.js";
import { runRefreshJob } from "../src/hosting/refresh-job.js";
import { REFRESH_INTERVAL_MS } from "../src/hosting/refresh-policy.js";
import { GitHubRequestError } from "../src/data/github-pages.js";
import { readManifest } from "../src/storage/private-repository.js";
import { REFRESH_NOW, refreshFixture } from "./helpers/refresh-fixture.js";

const SECRET = "cron-test-secret";

function limits(now: number, overrides: Partial<CronLimits> = {}): CronLimits {
  return { deadline: new Date(now + 120_000), maxRequests: 100, userBudgetMs: 60_000, minUserBudgetMs: CRON_MIN_USER_BUDGET_MS, ...overrides };
}

function cronRequest(authorization?: string, method = "GET"): Request {
  return new Request("https://example.test/api/cron", {
    method, headers: authorization === undefined ? {} : { Authorization: authorization },
  });
}

/** 요청 예산 없이 job을 실행해 pending checkpoint만 있는 미발행 사용자를 준비합니다. */
async function register(f: ReturnType<typeof refreshFixture>, ...usernames: string[]): Promise<void> {
  for (const username of usernames) {
    const outcome = await runRefreshJob(username, { deadline: new Date(f.clock.now + 60_000), maxRequests: 0 }, f.dependencies);
    assert.equal(outcome.status, "paused");
  }
}

test("cron rejects missing configuration, bad credentials, and non-GET methods before any work", async () => {
  const f = refreshFixture();
  const forbidden = () => assert.fail("limits must not be computed");
  const configured = { secret: SECRET, dependencies: f.dependencies };
  const cases: Array<[Request, typeof configured | { secret: string | undefined; dependencies: undefined }, number, string]> = [
    [cronRequest(`Bearer ${SECRET}`, "POST"), configured, 405, "method_not_allowed"],
    [cronRequest(`Bearer ${SECRET}`, "HEAD"), configured, 405, ""],
    [cronRequest(`Bearer ${SECRET}`), { secret: undefined, dependencies: undefined }, 503, "not_configured"],
    [cronRequest(), configured, 401, "unauthorized"],
    [cronRequest(`Bearer ${SECRET}x`), configured, 401, "unauthorized"],
    [cronRequest(SECRET), configured, 401, "unauthorized"],
    [cronRequest(`Bearer ${SECRET}`), { secret: SECRET, dependencies: undefined }, 503, "not_configured"],
  ];
  for (const [request, config, status, body] of cases) {
    const response = await cronResponse(request, config, forbidden);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const text = await response.text();
    assert.equal(body === "" ? text : (JSON.parse(text) as { status: string }).status, body);
    assert.equal(text.includes(SECRET), false);
  }
  assert.equal(f.privateStore.objects.size, 0);
  assert.equal(f.calls.length, 0);
});

test("an authorized cron run bootstraps registered users and reports only aggregate counts", async () => {
  const f = refreshFixture();
  await register(f, "alpha", "beta");
  const response = await cronResponse(cronRequest(`Bearer ${SECRET}`), { secret: SECRET, dependencies: f.dependencies }, () => limits(f.clock.now));
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.deepEqual({ ...body, requests: undefined }, {
    status: "ok", due: 2, processed: 2, published: 2, requests: undefined, errors: 0,
    statuses: { paused: 0, busy: 0, conflict: 0, failed: 0, ready: 2 }, stopped: "complete",
  });
  assert.equal(body.requests, f.calls.length);
  assert.equal(JSON.stringify(body).includes("alpha"), false);
  for (const username of ["alpha", "beta"]) {
    assert.ok(await readManifest(f.privateStore, username));
  }
});

test("repeated and next-day cron runs are idempotent until the refresh interval passes", async () => {
  const f = refreshFixture();
  await register(f, "alpha");
  assert.equal((await runCron(limits(f.clock.now), f.dependencies)).published, 1);
  const count = f.calls.length;
  const repeated = await runCron(limits(f.clock.now), f.dependencies);
  assert.deepEqual([repeated.due, repeated.processed, repeated.requests], [0, 0, 0]);
  assert.equal(f.calls.length, count);

  f.clock.now += REFRESH_INTERVAL_MS;
  const nextDay = await runCron(limits(f.clock.now), f.dependencies);
  assert.deepEqual([nextDay.due, nextDay.published], [1, 1]);
  const stored = await readManifest(f.privateStore, "alpha");
  assert.equal(stored?.manifest.current.generatedAt, new Date(f.clock.now).toISOString());
  assert.equal(stored?.manifest.previous?.generatedAt, new Date(REFRESH_NOW).toISOString());
});

test("overlapping cron runs publish each user once", async () => {
  const f = refreshFixture();
  await register(f, "alpha", "beta");
  const [left, right] = await Promise.all([
    runCron(limits(f.clock.now), f.dependencies),
    runCron(limits(f.clock.now), f.dependencies),
  ]);
  assert.equal(left.published + right.published, 2);
  assert.equal(f.calls.filter((request) => request.kind === "profile").length, 2);
});

test("the loop stops at the deadline, request limit, or GitHub rate limit and leaves the rest for the next run", async () => {
  const f = refreshFixture();
  await register(f, "alpha", "beta");
  const late = await runCron(limits(f.clock.now, { deadline: new Date(f.clock.now + CRON_MIN_USER_BUDGET_MS - 1) }), f.dependencies);
  assert.deepEqual([late.due, late.processed, late.stopped], [2, 0, "deadline"]);

  const limited = await runCron(limits(f.clock.now, { maxRequests: 1 }), f.dependencies);
  assert.deepEqual([limited.processed, limited.requests, limited.stopped], [1, 1, "requests"]);

  const request = f.dependencies.github.requestPage;
  f.dependencies.github.requestPage = async () => { throw new GitHubRequestError("rate limited", 1_000); };
  const throttled = await runCron(limits(f.clock.now), f.dependencies);
  assert.deepEqual([throttled.processed, throttled.stopped], [1, "rate-limit"]);
  f.dependencies.github.requestPage = request;
});

test("one user's storage error is counted and the next user still refreshes", async () => {
  const f = refreshFixture();
  await register(f, "alpha", "beta");
  const load = f.dependencies.checkpoints.load.bind(f.dependencies.checkpoints);
  f.dependencies.checkpoints.load = async (key, signal) => {
    if (key === "alpha") throw new Error("checkpoint unavailable");
    return load(key, signal);
  };
  const summary = await runCron(limits(f.clock.now), f.dependencies);
  assert.deepEqual([summary.processed, summary.errors, summary.published], [2, 1, 1]);
});

test("a listing failure becomes a 500 without leaking the error", async () => {
  const f = refreshFixture();
  f.privateStore.list = async () => { throw new Error("list failed for secret path"); };
  const response = await cronResponse(cronRequest(`Bearer ${SECRET}`), { secret: SECRET, dependencies: f.dependencies }, () => limits(f.clock.now));
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { status: "error" });
});
