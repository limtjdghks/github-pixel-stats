import assert from "node:assert/strict";
import test from "node:test";
import { FAILED_RETENTION_MS, markUserRemoved } from "../src/hosting/admission-policy.js";
import { bootstrapUser } from "../src/hosting/bootstrap.js";
import { CRON_MIN_USER_BUDGET_MS, runCron, type CronLimits } from "../src/hosting/cron-run.js";
import { runRefreshJob } from "../src/hosting/refresh-job.js";
import { readAdmissions, updateAdmissions } from "../src/storage/admissions.js";
import { checkpointPathname } from "../src/storage/pathnames.js";
import { readManifest } from "../src/storage/private-repository.js";
import { readUsage } from "../src/storage/usage.js";
import { refreshFixture } from "./helpers/refresh-fixture.js";

type Fixture = ReturnType<typeof refreshFixture>;
const DAY = 24 * 60 * 60 * 1000;

function limits(now: number): CronLimits {
  return { deadline: new Date(now + 120_000), maxRequests: 100, userBudgetMs: 60_000, minUserBudgetMs: CRON_MIN_USER_BUDGET_MS };
}

/** 존재하지 않는 사용자처럼 수집이 실패해 실패 표시된 미발행 사용자를 만듭니다. */
async function failUser(f: Fixture, username: string): Promise<void> {
  f.missing.add(username);
  await bootstrapUser(username, new Date(f.clock.now + 20_000), f.dependencies);
  assert.notEqual((await readAdmissions(f.privateStore)).admissions.users[username]?.failedAt, null);
}

test("cron removes failed unpublished users after the retention period and keeps recent ones", async () => {
  const f = refreshFixture();
  await failUser(f, "old-ghost");
  f.clock.now += DAY;
  await failUser(f, "new-ghost");
  f.clock.now += FAILED_RETENTION_MS - DAY;
  const calls = f.calls.length;
  const summary = await runCron(limits(f.clock.now), f.dependencies);
  assert.equal(summary.expired, 1);
  const users = (await readAdmissions(f.privateStore)).admissions.users;
  assert.equal(users["old-ghost"], undefined);
  assert.notEqual(users["new-ghost"], undefined);
  assert.equal(f.privateStore.objects.has(checkpointPathname("old-ghost")), false);
  assert.equal(f.privateStore.objects.has(checkpointPathname("new-ghost")), true);
  assert.equal(f.calls.slice(calls).some((request) => "username" in request && request.username === "old-ghost"), false);

  // 지워진 사용자는 다음 카드 요청에서 신규 사용자로 다시 등록됩니다.
  await bootstrapUser("old-ghost", new Date(f.clock.now + 20_000), f.dependencies);
  assert.notEqual((await readAdmissions(f.privateStore)).admissions.users["old-ghost"], undefined);
});

test("cron keeps the admission entry when deleting an expired checkpoint fails", async () => {
  const f = refreshFixture();
  await failUser(f, "ghost");
  f.clock.now += FAILED_RETENTION_MS;
  f.privateStore.delete = async () => { throw new Error("delete failed"); };
  const original = console.error;
  console.error = () => {};
  try {
    const summary = await runCron(limits(f.clock.now), f.dependencies);
    assert.equal(summary.expired, 0);
    assert.ok(summary.errors >= 1);
  } finally {
    console.error = original;
  }
  assert.notEqual((await readAdmissions(f.privateStore)).admissions.users.ghost?.failedAt, null);
});

test("an expired user marked removed during the run keeps its admission entry", async () => {
  const f = refreshFixture();
  await failUser(f, "ghost");
  f.clock.now += FAILED_RETENTION_MS;
  await runRefreshJob("alpha", { deadline: new Date(f.clock.now + 60_000), maxRequests: 0 }, f.dependencies);
  // Cron이 등록 기록을 읽은 뒤, alpha를 갱신하는 동안 운영자가 ghost에 삭제 표시를 남깁니다.
  const request = f.dependencies.github.requestPage;
  let marked = false;
  f.dependencies.github.requestPage = async (page, signal) => {
    if (!marked) {
      marked = true;
      await updateAdmissions(f.privateStore, (current) => markUserRemoved(current, "ghost", new Date(f.clock.now)));
    }
    return request(page, signal);
  };
  const summary = await runCron(limits(f.clock.now), f.dependencies);
  assert.deepEqual([summary.expired, summary.published], [1, 1]);
  const users = (await readAdmissions(f.privateStore)).admissions.users;
  assert.equal(typeof users.ghost?.removedAt, "string");
  assert.equal(f.privateStore.objects.has(checkpointPathname("ghost")), false);
});

test("cron does not refresh users with a removal mark even when a checkpoint is left", async () => {
  const f = refreshFixture();
  await runRefreshJob("alpha", { deadline: new Date(f.clock.now + 60_000), maxRequests: 0 }, f.dependencies);
  await updateAdmissions(f.privateStore, (current) => markUserRemoved(current, "alpha", new Date(f.clock.now)));
  const summary = await runCron(limits(f.clock.now), f.dependencies);
  assert.deepEqual([summary.due, summary.processed], [0, 0]);
  assert.equal(f.calls.length, 0);
  assert.equal(await readManifest(f.privateStore, "alpha"), null);
});

test("publish failures are counted separately and recorded in the daily usage", async () => {
  const f = refreshFixture();
  await runRefreshJob("alpha", { deadline: new Date(f.clock.now + 60_000), maxRequests: 0 }, f.dependencies);
  const write = f.publicStore.write.bind(f.publicStore);
  f.publicStore.write = async () => { throw new Error("card write failed"); };
  const events: Array<Record<string, unknown>> = [];
  const original = console.error;
  console.error = (line: unknown) => { events.push(JSON.parse(String(line)) as Record<string, unknown>); };
  try {
    const summary = await runCron(limits(f.clock.now), f.dependencies);
    assert.deepEqual([summary.errors, summary.publishFailures, summary.published], [1, 1, 0]);
  } finally {
    console.error = original;
  }
  assert.deepEqual(events.map(({ event, error }) => [event, error]), [["cron.publish_failed", "card write failed"]]);
  assert.equal((await readUsage(f.privateStore, new Date(f.clock.now))).usage.cron.publishFailures, 1);

  // 저장된 `ready` 결과는 다음 실행이 GitHub 요청 없이 이어서 발행합니다.
  f.publicStore.write = write;
  const calls = f.calls.length;
  const retried = await runCron(limits(f.clock.now), f.dependencies);
  assert.deepEqual([retried.published, retried.publishFailures, f.calls.length], [1, 0, calls]);
});
