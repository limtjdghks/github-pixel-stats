import assert from "node:assert/strict";
import test from "node:test";
import { cronResponse } from "../src/hosting/cron-response.js";
import { CRON_MIN_USER_BUDGET_MS, runCron, type CronLimits } from "../src/hosting/cron-run.js";
import { runRefreshJob } from "../src/hosting/refresh-job.js";
import { REFRESH_INTERVAL_MS } from "../src/hosting/refresh-policy.js";
import { GitHubRequestError } from "../src/data/github-pages.js";
import { bootstrapUser } from "../src/hosting/bootstrap.js";
import { cardResponse } from "../src/hosting/card-response.js";
import { admitUser, markAdmissionFailures } from "../src/hosting/admission-policy.js";
import { readAdmissions, updateAdmissions } from "../src/storage/admissions.js";
import { ADMISSIONS_PATHNAME } from "../src/storage/pathnames.js";
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
  assert.deepEqual({ ...body, requests: undefined, blob: undefined }, {
    status: "ok", due: 2, processed: 2, published: 2, requests: undefined, errors: 0, publishFailures: 0, expired: 0,
    statuses: { paused: 0, busy: 0, conflict: 0, failed: 0, ready: 2 }, stopped: "complete", blob: undefined,
  });
  const blob = body.blob as { operations: { advanced: number }; dailyAdvanced: number; dailyBudget: number };
  assert.equal(blob.dailyBudget, 60);
  assert.equal(blob.dailyAdvanced, blob.operations.advanced);
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

test("a long primary rate limit stops the loop after one request without failing the remaining users", async () => {
  const f = refreshFixture();
  await register(f, "alpha", "beta", "gamma");
  f.dependencies.github.requestPage = async () => { throw new GitHubRequestError("rate limited", 30 * 60_000, 403); };
  const summary = await runCron(limits(f.clock.now), f.dependencies);
  assert.deepEqual([summary.processed, summary.requests, summary.stopped], [1, 1, "rate-limit"]);
  assert.equal(summary.statuses.failed, 0);
  for (const username of ["alpha", "beta", "gamma"]) {
    const stored = await f.dependencies.checkpoints.load(username, AbortSignal.timeout(1_000));
    assert.notEqual((stored?.value as { status: string }).status, "failed");
  }
});

test("stale published users are refreshed before unpublished users that keep failing", async () => {
  const f = refreshFixture();
  await register(f, "real");
  await runCron(limits(f.clock.now), f.dependencies);
  for (const ghost of ["ghost-a", "ghost-b", "ghost-c"]) f.missing.add(ghost);
  await register(f, "ghost-a", "ghost-b", "ghost-c");
  for (let day = 1; day <= 2; day += 1) {
    f.clock.now += REFRESH_INTERVAL_MS;
    const summary = await runCron(limits(f.clock.now, { maxRequests: 6 }), f.dependencies);
    assert.equal(summary.published, 1);
    const stored = await readManifest(f.privateStore, "real");
    assert.equal(stored?.manifest.current.generatedAt, new Date(f.clock.now).toISOString());
  }
});

test("GitHub requests of a user whose job throws still count toward the run limit", async () => {
  const f = refreshFixture();
  await register(f, "alpha", "beta", "gamma");
  f.publicStore.write = async () => { throw new Error("public store unavailable"); };
  const originalError = console.error;
  console.error = () => {};
  try {
    const summary = await runCron(limits(f.clock.now, { maxRequests: 6 }), f.dependencies);
    assert.equal(summary.requests, f.calls.length);
    assert.ok(summary.requests <= 6);
    assert.equal(summary.stopped, "requests");
    assert.ok(summary.errors >= 1);
  } finally {
    console.error = originalError;
  }
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

/** 등록 기록에 사용자를 등록하고, `failed`에 든 사용자에는 실패를 표시합니다. */
async function admit(f: ReturnType<typeof refreshFixture>, usernames: string[], failed: string[] = []): Promise<void> {
  const now = new Date(f.clock.now);
  await updateAdmissions(f.privateStore, (current) => {
    let next = current;
    for (const username of usernames) next = admitUser(next, username, now) ?? next;
    return markAdmissionFailures(next, failed, now) ?? next;
  });
}

async function failedAt(f: ReturnType<typeof refreshFixture>, username: string): Promise<string | null | undefined> {
  return (await readAdmissions(f.privateStore)).admissions.users[username]?.failedAt;
}

test("cron clears the failure mark only for the failed user it publishes", async () => {
  const f = refreshFixture();
  f.missing.add("ghost");
  f.missing.add("phantom");
  await bootstrapUser("ghost", new Date(f.clock.now + 20_000), f.dependencies);
  await bootstrapUser("phantom", new Date(f.clock.now + 20_000), f.dependencies);
  const calls: string[] = [];
  const card = (username: string) => cardResponse(new Request(`https://example.test/${username}/stats.svg`), f.dependencies.stores, {
    now: f.dependencies.now,
    onPending: (user) => { calls.push(user); },
  });
  assert.equal((await card("ghost")).headers.get("X-Card-Status"), "failed");

  f.missing.delete("ghost");
  f.clock.now += 60_000;
  const summary = await runCron(limits(f.clock.now), f.dependencies);
  assert.equal(summary.published, 1);
  assert.equal(summary.errors, 0);
  assert.equal(await failedAt(f, "ghost"), null);
  assert.notEqual(await failedAt(f, "phantom"), null);
  assert.equal((await card("ghost")).headers.get("X-Card-Status"), "ready");
  assert.equal((await card("phantom")).headers.get("X-Card-Status"), "failed");
  assert.deepEqual(calls, []);
});

test("cron marks registered unpublished users whose collection fails during the run", async () => {
  const f = refreshFixture();
  await admit(f, ["ghost"]);
  // bootstrap이 GitHub 요청 전에 멈춰, 존재하지 않는 사용자의 실패를 Cron이 처음 확인하는 상황입니다.
  await register(f, "ghost");
  f.missing.add("ghost");
  const summary = await runCron(limits(f.clock.now), f.dependencies);
  assert.equal(summary.statuses.failed, 1);
  assert.equal(await failedAt(f, "ghost"), new Date(f.clock.now).toISOString());
});

test("cron refreshes failure-marked unpublished users after the other unpublished users", async () => {
  const f = refreshFixture();
  await register(f, "aa-ghost", "zz-user");
  await admit(f, ["aa-ghost", "zz-user"], ["aa-ghost"]);
  await runCron(limits(f.clock.now), f.dependencies);
  const profiles = f.calls.filter((page) => page.kind === "profile").map((page) => page.username);
  assert.deepEqual(profiles, ["zz-user", "aa-ghost"]);
});

test("cron clears a failure mark left on a published user and skips the write when nothing changes", async () => {
  const f = refreshFixture();
  await register(f, "alpha");
  await runCron(limits(f.clock.now), f.dependencies);
  // 발행 직후 job이 오류로 끝나 해제가 빠진 상황처럼, 발행된 사용자에 실패 표시만 남깁니다.
  await admit(f, ["alpha"], ["alpha"]);
  const write = f.privateStore.write.bind(f.privateStore);
  const admissionWrites: string[] = [];
  f.privateStore.write = async (pathname, ...rest) => {
    if (pathname === ADMISSIONS_PATHNAME) admissionWrites.push(pathname);
    return write(pathname, ...rest);
  };

  const summary = await runCron(limits(f.clock.now), f.dependencies);
  assert.equal(summary.due, 0);
  assert.equal(await failedAt(f, "alpha"), null);
  assert.equal(admissionWrites.length, 1);
  await runCron(limits(f.clock.now), f.dependencies);
  assert.equal(admissionWrites.length, 1);
});

test("an unreadable or unwritable admission record is counted without stopping the refresh", async () => {
  for (const failing of ["read", "write"] as const) {
    const f = refreshFixture();
    await register(f, "alpha");
    await admit(f, ["alpha"], ["alpha"]);
    if (failing === "read") {
      const read = f.privateStore.read.bind(f.privateStore);
      f.privateStore.read = async (pathname, signal) => {
        if (pathname === ADMISSIONS_PATHNAME) throw new Error("admissions unavailable");
        return read(pathname, signal);
      };
    } else {
      const write = f.privateStore.write.bind(f.privateStore);
      f.privateStore.write = async (pathname, ...rest) => {
        if (pathname === ADMISSIONS_PATHNAME) throw new Error("admissions unavailable");
        return write(pathname, ...rest);
      };
    }
    const originalError = console.error;
    console.error = () => {};
    try {
      const summary = await runCron(limits(f.clock.now), f.dependencies);
      assert.equal(summary.published, 1, failing);
      assert.equal(summary.errors, 1, failing);
    } finally {
      console.error = originalError;
    }
    const response = await cardResponse(new Request("https://example.test/alpha/stats.svg"), f.dependencies.stores);
    assert.equal(response.headers.get("X-Card-Status"), "ready", failing);
  }
});
