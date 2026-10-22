import assert from "node:assert/strict";
import test from "node:test";
import { parseOpsCommand } from "../src/cli/ops-options.js";
import { markUserRemoved } from "../src/hosting/admission-policy.js";
import { bootstrapUser } from "../src/hosting/bootstrap.js";
import { cardResponse } from "../src/hosting/card-response.js";
import { CRON_MIN_USER_BUDGET_MS, runCron, type CronLimits } from "../src/hosting/cron-run.js";
import { deleteUser, recentUsage, restoreUser, rollbackUser, serviceStatus, STUCK_PUBLISH_MS } from "../src/hosting/operator.js";
import { runRefreshJob } from "../src/hosting/refresh-job.js";
import { REFRESH_INTERVAL_MS } from "../src/hosting/refresh-policy.js";
import { readAdmissions, updateAdmissions } from "../src/storage/admissions.js";
import { checkpointPathname, manifestPathname, releasePathnames } from "../src/storage/pathnames.js";
import { readManifest } from "../src/storage/private-repository.js";
import { refreshFixture } from "./helpers/refresh-fixture.js";

type Fixture = ReturnType<typeof refreshFixture>;

function limits(now: number): CronLimits {
  return { deadline: new Date(now + 120_000), maxRequests: 100, userBudgetMs: 60_000, minUserBudgetMs: CRON_MIN_USER_BUDGET_MS };
}

const now = (f: Fixture) => new Date(f.clock.now);
const card = (f: Fixture, username: string) =>
  cardResponse(new Request(`https://example.test/${username}/stats.svg`), f.dependencies.stores);

/** 오류 로그를 버린 채 `run`을 실행합니다. 일부러 실패시키는 경로의 로그가 테스트 출력을 덮지 않게 합니다. */
async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const original = { log: console.log, error: console.error };
  console.log = () => {};
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.log = original.log;
    console.error = original.error;
  }
}

/** 발행을 두 번 해 current와 previous가 모두 있는 사용자를 만듭니다. */
async function publishTwice(f: Fixture, username: string): Promise<void> {
  await bootstrapUser(username, new Date(f.clock.now + 20_000), f.dependencies);
  f.clock.now += REFRESH_INTERVAL_MS;
  await quietly(() => runCron(limits(f.clock.now), f.dependencies));
  const stored = await readManifest(f.privateStore, username);
  assert.notEqual(stored?.manifest.previous, null);
}

test("status reports counts, failure and removal marks, and only ready results that stopped publishing", async () => {
  const f = refreshFixture();
  await bootstrapUser("alpha", new Date(f.clock.now + 20_000), f.dependencies);
  f.missing.add("ghost");
  await bootstrapUser("ghost", new Date(f.clock.now + 20_000), f.dependencies);
  await updateAdmissions(f.privateStore, (current) => markUserRemoved(current, "gone", now(f)));
  await runRefreshJob("waiting", { deadline: new Date(f.clock.now + 60_000), maxRequests: 0 }, f.dependencies);
  const write = f.publicStore.write.bind(f.publicStore);
  f.publicStore.write = async () => { throw new Error("card write failed"); };
  await assert.rejects(runRefreshJob("stuck", { deadline: new Date(f.clock.now + 60_000), maxRequests: 100 }, f.dependencies));
  f.publicStore.write = write;
  await f.privateStore.write(checkpointPathname("broken"), "corrupt", {
    contentType: "application/json", cacheControlMaxAge: 60, condition: { kind: "absent" },
  });

  const early = await serviceStatus(f.privateStore, now(f));
  assert.deepEqual(early.stuck, []);
  f.clock.now += STUCK_PUBLISH_MS;
  const status = await serviceStatus(f.privateStore, now(f));
  assert.deepEqual({ ...status, stuck: status.stuck.map(({ username, publishedAt }) => [username, publishedAt]) }, {
    published: 1, unpublished: 4, failed: ["ghost"], removed: ["gone"], stuck: [["stuck", null]], unreadable: ["broken"],
  });
});

test("delete previews without changes, then removes every object and blocks recollection until restored", async () => {
  const f = refreshFixture();
  await publishTwice(f, "alpha");
  const objects = () => [...f.privateStore.objects.keys(), ...f.publicStore.objects.keys()].filter((path) => path.includes("alpha"));
  const before = objects();

  const preview = await deleteUser(f.dependencies.stores, "Alpha", now(f), false);
  assert.deepEqual(Object.keys(preview), ["planned"]);
  assert.deepEqual([...preview.planned.private, ...preview.planned.public].sort(), [...before].sort());
  assert.deepEqual(objects(), before);
  assert.equal(await readManifest(f.privateStore, "alpha") === null, false);

  const result = await deleteUser(f.dependencies.stores, "Alpha", now(f), true);
  assert.deepEqual(result.remaining, { private: [], public: [] });
  assert.deepEqual(objects(), []);
  assert.equal(typeof (await readAdmissions(f.privateStore)).admissions.users.alpha?.removedAt, "string");
  assert.equal((await card(f, "alpha")).headers.get("X-Card-Status"), "removed");

  const calls = f.calls.length;
  await bootstrapUser("alpha", new Date(f.clock.now + 20_000), f.dependencies);
  f.clock.now += REFRESH_INTERVAL_MS;
  await runCron(limits(f.clock.now), f.dependencies);
  assert.equal(f.calls.length, calls);
  assert.deepEqual(objects(), []);

  assert.equal(await restoreUser(f.privateStore, "alpha"), true);
  assert.equal(await restoreUser(f.privateStore, "alpha"), false);
  assert.equal((await card(f, "alpha")).headers.get("X-Card-Status"), "pending");
  await bootstrapUser("alpha", new Date(f.clock.now + 20_000), f.dependencies);
  assert.equal((await card(f, "alpha")).headers.get("X-Card-Status"), "ready");
});

test("rollback serves the previous release and the next cron does not republish the rolled-back result", async () => {
  const f = refreshFixture();
  await publishTwice(f, "alpha");
  const before = (await readManifest(f.privateStore, "alpha"))!.manifest;
  const previousSvg = f.publicStore.objects.get(releasePathnames("alpha", before.previous!.version, before.previous!.mascots).public.stats.cat)!.body;

  const preview = await rollbackUser(f.dependencies.stores, "alpha", now(f), false);
  assert.deepEqual(preview, {
    from: { version: before.current.version, generatedAt: before.current.generatedAt },
    to: { version: before.previous!.version, generatedAt: before.previous!.generatedAt },
    checkpoint: true,
  });
  assert.deepEqual((await readManifest(f.privateStore, "alpha"))!.manifest, before);

  await rollbackUser(f.dependencies.stores, "alpha", now(f), true);
  const after = (await readManifest(f.privateStore, "alpha"))!.manifest;
  assert.equal(after.current.version, before.previous!.version);
  assert.equal(after.previous, null);
  assert.ok(after.retired.some((entry) => entry.version === before.current.version));
  assert.equal(f.privateStore.objects.has(checkpointPathname("alpha")), false);
  assert.equal(await (await card(f, "alpha")).text(), previousSvg);

  const summary = await runCron(limits(f.clock.now), f.dependencies);
  assert.equal(summary.processed, 0);
  assert.equal((await readManifest(f.privateStore, "alpha"))!.manifest.current.version, before.previous!.version);
  await assert.rejects(rollbackUser(f.dependencies.stores, "alpha", now(f), true), /No previous release/);
  await assert.rejects(rollbackUser(f.dependencies.stores, "nobody", now(f), true), /No published manifest/);
});

test("a rollback that loses a manifest race keeps the manifest and asks for a new preview", async () => {
  const f = refreshFixture();
  await publishTwice(f, "alpha");
  const path = manifestPathname("alpha");
  const before = f.privateStore.objects.get(path)!;
  // checkpoint를 지운 직후 다른 발행이 manifest를 바꾼 상황을 ETag 변경으로 흉내 냅니다.
  const remove = f.privateStore.delete.bind(f.privateStore);
  f.privateStore.delete = async (pathnames) => {
    await remove(pathnames);
    f.privateStore.objects.set(path, { ...f.privateStore.objects.get(path)!, etag: '"concurrent"' });
  };
  await assert.rejects(rollbackUser(f.dependencies.stores, "alpha", now(f), true), /without --yes to review/);
  assert.equal(f.privateStore.objects.get(path)!.body, before.body);
  assert.equal(f.privateStore.objects.has(checkpointPathname("alpha")), false);
});

test("rollback refuses while a collection lease is active", async () => {
  const f = refreshFixture();
  await publishTwice(f, "alpha");
  f.clock.now += REFRESH_INTERVAL_MS;
  // 새 수집 job이 lease를 잡고 첫 GitHub 요청에서 멈춘 동안 rollback을 시도합니다.
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const requested = new Promise<void>((resolve) => { started = resolve; });
  const request = f.dependencies.github.requestPage;
  f.dependencies.github.requestPage = async (page, signal) => {
    started();
    await blocked;
    return request(page, signal);
  };
  const job = runRefreshJob("alpha", { deadline: new Date(f.clock.now + 60_000), maxRequests: 100 }, f.dependencies);
  await requested;
  const before = (await readManifest(f.privateStore, "alpha"))!.manifest;
  await assert.rejects(rollbackUser(f.dependencies.stores, "alpha", now(f), true), /collection is running/);
  assert.deepEqual((await readManifest(f.privateStore, "alpha"))!.manifest, before);
  assert.equal(f.privateStore.objects.has(checkpointPathname("alpha")), true);
  release();
  await job;
});

test("recent usage lists each day from today backwards", async () => {
  const f = refreshFixture();
  await bootstrapUser("alpha", new Date(f.clock.now + 20_000), f.dependencies);
  const usage = await recentUsage(f.privateStore, now(f), 3);
  assert.deepEqual(usage.map((day) => day.date), ["2026-10-01", "2026-09-30", "2026-09-29"]);
  assert.equal(usage[0]!.bootstrap.runs, 1);
  assert.equal(usage[1]!.bootstrap.runs, 0);
});

test("ops arguments require explicit confirmation for changes and reject unknown input", () => {
  assert.deepEqual(parseOpsCommand(["status"]), { name: "status" });
  assert.deepEqual(parseOpsCommand(["usage"]), { name: "usage", days: 7 });
  assert.deepEqual(parseOpsCommand(["usage", "--days", "30"]), { name: "usage", days: 30 });
  assert.deepEqual(parseOpsCommand(["delete", "Alice"]), { name: "delete", username: "Alice", apply: false });
  assert.deepEqual(parseOpsCommand(["rollback", "alice", "--yes"]), { name: "rollback", username: "alice", apply: true });
  assert.deepEqual(parseOpsCommand(["restore", "alice"]), { name: "restore", username: "alice" });
  for (const argv of [[], ["bogus"], ["status", "alice"], ["usage", "--days", "0"], ["usage", "--days", "91"], ["delete"],
    ["delete", "a", "b"], ["delete", "bad--name"], ["restore", "alice", "--yes"], ["rollback", "alice", "--force"]]) {
    assert.throws(() => parseOpsCommand(argv), /Usage: npm run ops|username/, argv.join(" "));
  }
});
