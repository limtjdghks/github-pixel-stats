import assert from "node:assert/strict";
import test from "node:test";
import { bootstrapUser } from "../src/hosting/bootstrap.js";
import { cardResponse } from "../src/hosting/card-response.js";
import { CRON_MIN_USER_BUDGET_MS, runCron, type CronLimits } from "../src/hosting/cron-run.js";
import { runRefreshJob } from "../src/hosting/refresh-job.js";
import { REFRESH_INTERVAL_MS } from "../src/hosting/refresh-policy.js";
import {
  BOOTSTRAP_DAILY_ADVANCED_BUDGET,
  DAILY_ADVANCED_BUDGET,
  JOB_ADVANCED_ESTIMATE,
  USAGE_RECORD_OPERATIONS,
  USAGE_RETENTION_DAYS,
} from "../src/hosting/usage-policy.js";
import { readAdmissions } from "../src/storage/admissions.js";
import { ADMISSIONS_PATHNAME, usagePathname } from "../src/storage/pathnames.js";
import { readManifest } from "../src/storage/private-repository.js";
import { readUsage, updateUsage } from "../src/storage/usage.js";
import { REFRESH_NOW, refreshFixture } from "./helpers/refresh-fixture.js";

type Fixture = ReturnType<typeof refreshFixture>;

function limits(now: number): CronLimits {
  return { deadline: new Date(now + 120_000), maxRequests: 100, userBudgetMs: 60_000, minUserBudgetMs: CRON_MIN_USER_BUDGET_MS };
}

async function seedUsage(f: Fixture, advanced: number, bootstrapAdvanced = 0): Promise<void> {
  await updateUsage(f.privateStore, new Date(f.clock.now), (usage) => ({
    ...usage,
    blob: { advanced, simple: 0 },
    bootstrap: { ...usage.bootstrap, advanced: bootstrapAdvanced },
  }));
}

/** Function 로그를 JSON 이벤트로 모아 `run`이 끝나면 원래 함수로 되돌립니다. */
async function captureLogs(run: () => Promise<void>): Promise<Array<Record<string, unknown>>> {
  const events: Array<Record<string, unknown>> = [];
  const original = { log: console.log, error: console.error };
  const collect = (line: unknown) => { events.push(JSON.parse(String(line)) as Record<string, unknown>); };
  console.log = collect;
  console.error = collect;
  try {
    await run();
  } finally {
    console.log = original.log;
    console.error = original.error;
  }
  return events;
}

test("cron records the operations it used and repeated runs accumulate in the daily usage", async () => {
  const f = refreshFixture();
  await runRefreshJob("alpha", { deadline: new Date(f.clock.now + 60_000), maxRequests: 0 }, f.dependencies);
  const first = await runCron(limits(f.clock.now), f.dependencies);
  assert.equal(first.published, 1);
  assert.ok(first.blob.operations.advanced > USAGE_RECORD_OPERATIONS.advanced);
  assert.ok(first.blob.operations.advanced <= JOB_ADVANCED_ESTIMATE + 2 + USAGE_RECORD_OPERATIONS.advanced);
  const second = await runCron(limits(f.clock.now), f.dependencies);
  assert.equal(second.processed, 0);
  const { usage } = await readUsage(f.privateStore, new Date(f.clock.now));
  assert.equal(usage.cron.runs, 2);
  assert.equal(usage.cron.published, 1);
  assert.equal(usage.blob.advanced, first.blob.operations.advanced + second.blob.operations.advanced);
  assert.equal(second.blob.dailyAdvanced, usage.blob.advanced);
});

test("cron stops before a user when the daily budget has no room for a job and published cards keep serving", async () => {
  const f = refreshFixture();
  await runRefreshJob("alpha", { deadline: new Date(f.clock.now + 60_000), maxRequests: 0 }, f.dependencies);
  await runCron(limits(f.clock.now), f.dependencies);
  f.clock.now += REFRESH_INTERVAL_MS;
  await seedUsage(f, DAILY_ADVANCED_BUDGET - JOB_ADVANCED_ESTIMATE);
  const calls = f.calls.length;
  const summary = await runCron(limits(f.clock.now), f.dependencies);
  assert.deepEqual([summary.due, summary.processed, summary.stopped], [1, 0, "blob-budget"]);
  assert.equal(f.calls.length, calls);
  const response = await cardResponse(new Request("https://example.test/alpha/stats.svg"), f.dependencies.stores);
  assert.equal(response.headers.get("X-Card-Status"), "ready");
});

test("cron does not refresh when the usage record cannot be read", async () => {
  const f = refreshFixture();
  await runRefreshJob("alpha", { deadline: new Date(f.clock.now + 60_000), maxRequests: 0 }, f.dependencies);
  await f.privateStore.write(usagePathname(new Date(f.clock.now)), "corrupt", {
    contentType: "application/json", cacheControlMaxAge: 60, condition: { kind: "content-addressed" },
  });
  const calls = f.calls.length;
  const events = await captureLogs(async () => {
    const summary = await runCron(limits(f.clock.now), f.dependencies);
    assert.deepEqual([summary.processed, summary.stopped, summary.blob.dailyAdvanced], [0, "blob-budget", null]);
  });
  assert.equal(f.calls.length, calls);
  assert.deepEqual(events.map((event) => event.event), ["cron.usage_read_failed", "cron.usage_update_failed"]);
  assert.equal(await readManifest(f.privateStore, "alpha"), null);
});

test("bootstrap records its operations and skips without admitting when its daily share is used", async () => {
  const f = refreshFixture();
  await bootstrapUser("alpha", new Date(f.clock.now + 20_000), f.dependencies);
  assert.ok(await readManifest(f.privateStore, "alpha"));
  const { usage } = await readUsage(f.privateStore, new Date(f.clock.now));
  assert.equal(usage.bootstrap.runs, 1);
  assert.equal(usage.bootstrap.published, 1);
  assert.ok(usage.bootstrap.advanced > USAGE_RECORD_OPERATIONS.advanced);
  assert.equal(usage.blob.advanced, usage.bootstrap.advanced);

  await seedUsage(f, BOOTSTRAP_DAILY_ADVANCED_BUDGET, BOOTSTRAP_DAILY_ADVANCED_BUDGET);
  const calls = f.calls.length;
  const events = await captureLogs(() => bootstrapUser("beta", new Date(f.clock.now + 20_000), f.dependencies));
  assert.deepEqual(events, [{ level: "info", event: "bootstrap.skipped", reason: "blob-budget" }]);
  assert.equal(f.calls.length, calls);
  assert.equal((await readAdmissions(f.privateStore)).admissions.users.beta, undefined);
  assert.equal((await readUsage(f.privateStore, new Date(f.clock.now))).usage.bootstrap.runs, 1);
});

test("bootstrap does not admit or collect when the usage record cannot be read", async () => {
  const f = refreshFixture();
  await f.privateStore.write(usagePathname(new Date(f.clock.now)), "corrupt", {
    contentType: "application/json", cacheControlMaxAge: 60, condition: { kind: "content-addressed" },
  });
  const events = await captureLogs(() => bootstrapUser("alpha", new Date(f.clock.now + 20_000), f.dependencies));
  assert.deepEqual(events.map(({ level, event }) => [level, event]), [["error", "bootstrap.failed"]]);
  assert.equal(f.calls.length, 0);
  assert.equal(f.privateStore.objects.has(ADMISSIONS_PATHNAME), false);
  assert.equal(f.privateStore.objects.get(usagePathname(new Date(f.clock.now)))?.body, "corrupt");
});

test("cron deletes usage records past the retention period before refreshing", async () => {
  const f = refreshFixture();
  const day = 24 * 60 * 60 * 1000;
  const dated = (days: number) => usagePathname(new Date(f.clock.now - days * day));
  for (const days of [USAGE_RETENTION_DAYS - 1, USAGE_RETENTION_DAYS, USAGE_RETENTION_DAYS + 6]) {
    await updateUsage(f.privateStore, new Date(f.clock.now - days * day), (usage) => usage);
  }
  await runRefreshJob("alpha", { deadline: new Date(f.clock.now + 60_000), maxRequests: 0 }, f.dependencies);
  // 첫 job이 시작되기 전에 이미 지워졌는지 확인해, 정리가 deadline 근처로 밀리지 않는 순서를 고정합니다.
  let removedBeforeRefresh: boolean | undefined;
  const request = f.dependencies.github.requestPage;
  f.dependencies.github.requestPage = async (page, signal) => {
    removedBeforeRefresh ??= !f.privateStore.objects.has(dated(USAGE_RETENTION_DAYS));
    return request(page, signal);
  };
  await runCron(limits(f.clock.now), f.dependencies);
  assert.equal(removedBeforeRefresh, true);
  assert.equal(f.privateStore.objects.has(dated(USAGE_RETENTION_DAYS - 1)), true);
  assert.equal(f.privateStore.objects.has(dated(USAGE_RETENTION_DAYS)), false);
  assert.equal(f.privateStore.objects.has(dated(USAGE_RETENTION_DAYS + 6)), false);
});

test("a bootstrap that fails while publishing still records the GitHub requests it sent", async () => {
  const f = refreshFixture();
  f.publicStore.write = async () => { throw new Error("card write failed"); };
  const events = await captureLogs(() => bootstrapUser("alpha", new Date(f.clock.now + 20_000), f.dependencies));
  assert.deepEqual(events.map(({ event }) => event), ["bootstrap.failed"]);
  assert.ok(f.calls.length > 0);
  const { usage } = await readUsage(f.privateStore, new Date(f.clock.now));
  assert.deepEqual([usage.bootstrap.runs, usage.bootstrap.published, usage.bootstrap.requests], [1, 0, f.calls.length]);
});

test("a bootstrap that only reads does not write a usage record", async () => {
  const f = refreshFixture();
  f.missing.add("ghost");
  await bootstrapUser("ghost", new Date(f.clock.now + 20_000), f.dependencies);
  const before = await readUsage(f.privateStore, new Date(f.clock.now));
  // 실패 표시된 사용자는 등록 기록만 읽고 끝나므로 Advanced Operation이 없습니다.
  await bootstrapUser("ghost", new Date(f.clock.now + 20_000), f.dependencies);
  assert.deepEqual(await readUsage(f.privateStore, new Date(f.clock.now)), before);
});
