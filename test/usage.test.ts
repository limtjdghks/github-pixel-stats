import assert from "node:assert/strict";
import test from "node:test";
import {
  BOOTSTRAP_DAILY_ADVANCED_BUDGET,
  DAILY_ADVANCED_BUDGET,
  JOB_ADVANCED_ESTIMATE,
  USAGE_RECORD_OPERATIONS,
  addBootstrapUsage,
  addCronUsage,
  bootstrapAllowed,
  cronAdvancedAllowance,
} from "../src/hosting/usage-policy.js";
import { countOperations, countingStore, emptyOperationCount } from "../src/storage/operation-count.js";
import { usagePathname } from "../src/storage/pathnames.js";
import { emptyUsage, readUsage, removeExpiredUsage, updateUsage, USAGE_UPDATE_ATTEMPTS, type DailyUsage } from "../src/storage/usage.js";
import { MemoryObjectStore } from "./helpers/memory-object-store.js";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const JSON_OPTIONS = { contentType: "application/json", cacheControlMaxAge: 60, condition: { kind: "content-addressed" } } as const;

function usageWith(advanced: number, bootstrapAdvanced = 0): DailyUsage {
  const usage = emptyUsage(NOW);
  return { ...usage, blob: { advanced, simple: 0 }, bootstrap: { ...usage.bootstrap, advanced: bootstrapAdvanced } };
}

test("counting stores add operations only to the enclosing scope and keep concurrent scopes apart", async () => {
  const store = countingStore(new MemoryObjectStore("private"));
  await store.write("outside.json", "{}", JSON_OPTIONS);
  const first = emptyOperationCount();
  const second = emptyOperationCount();
  await Promise.all([
    countOperations(first, async () => {
      await store.write("a.json", "{}", JSON_OPTIONS);
      await new Promise((resolve) => setTimeout(resolve, 1));
      await store.read("a.json");
      await store.list("dir/");
      await store.delete(["a.json"]);
    }),
    countOperations(second, async () => {
      await store.read("missing.json");
      await new Promise((resolve) => setTimeout(resolve, 1));
      await store.read("missing.json");
    }),
  ]);
  assert.deepEqual(first, { advanced: 2, simple: 1 });
  assert.deepEqual(second, { advanced: 0, simple: 2 });
});

test("usage is read as empty when absent and rejected when corrupted or dated differently", async () => {
  const store = new MemoryObjectStore("private");
  assert.deepEqual(await readUsage(store, NOW), { usage: emptyUsage(NOW), etag: null });
  assert.equal(usagePathname(NOW), "usage/2026-10-01.json");
  const corrupt: unknown[] = [
    "not json",
    { ...emptyUsage(NOW), date: "2026-09-30" },
    { ...emptyUsage(NOW), blob: { advanced: -1, simple: 0 } },
    { ...emptyUsage(NOW), cron: { ...emptyUsage(NOW).cron, runs: 1.5 } },
    { ...emptyUsage(NOW), bootstrap: undefined },
  ];
  for (const value of corrupt) {
    await store.write(usagePathname(NOW), typeof value === "string" ? value : JSON.stringify(value), JSON_OPTIONS);
    await assert.rejects(readUsage(store, NOW), /Usage/);
  }
  await assert.rejects(readUsage(new MemoryObjectStore("public"), NOW), /private store/);
});

test("concurrent usage updates retry conditional writes and keep every run", async () => {
  const store = new MemoryObjectStore("private");
  const run = { operations: { advanced: 3, simple: 2 }, published: true, requests: 4 };
  await Promise.all(Array.from({ length: 3 }, () => updateUsage(store, NOW, (current) => addBootstrapUsage(current, run))));
  const { usage } = await readUsage(store, NOW);
  assert.equal(usage.bootstrap.runs, 3);
  assert.equal(usage.bootstrap.requests, 12);
  assert.equal(usage.blob.advanced, 3 * (3 + USAGE_RECORD_OPERATIONS.advanced));
  assert.equal(usage.bootstrap.advanced, usage.blob.advanced);

  let writes = 0;
  store.write = async () => { writes += 1; return null; };
  await assert.rejects(updateUsage(store, NOW, (current) => current), /concurrently/);
  assert.equal(writes, USAGE_UPDATE_ATTEMPTS);
});

test("expired usage records are deleted without listing while recent ones are kept", async () => {
  const store = new MemoryObjectStore("private");
  for (const days of [0, 89, 90, 96, 97]) {
    await store.write(usagePathname(new Date(NOW.getTime() - days * DAY)), "{}", JSON_OPTIONS);
  }
  store.list = async () => assert.fail("expired usage must be deleted without listing");
  await removeExpiredUsage(store, NOW, 90, 7);
  assert.deepEqual([...store.objects.keys()].sort(), [
    usagePathname(new Date(NOW.getTime() - 97 * DAY)),
    usagePathname(new Date(NOW.getTime() - 89 * DAY)),
    usagePathname(NOW),
  ].sort());
});

test("budget rules leave room for the usage write and cap the bootstrap share", () => {
  const record = USAGE_RECORD_OPERATIONS.advanced;
  assert.equal(cronAdvancedAllowance(usageWith(0)), DAILY_ADVANCED_BUDGET - record);
  assert.equal(cronAdvancedAllowance(usageWith(DAILY_ADVANCED_BUDGET + 5)), 0);

  const share = BOOTSTRAP_DAILY_ADVANCED_BUDGET - JOB_ADVANCED_ESTIMATE - record;
  assert.equal(bootstrapAllowed(usageWith(share, share)), true);
  assert.equal(bootstrapAllowed(usageWith(share + 1, share + 1)), false);
  const total = DAILY_ADVANCED_BUDGET - JOB_ADVANCED_ESTIMATE - record;
  assert.equal(bootstrapAllowed(usageWith(total, 0)), true);
  assert.equal(bootstrapAllowed(usageWith(total + 1, 0)), false);
});

test("cron usage adds the run and its own record write to the daily totals", () => {
  const usage = addCronUsage(usageWith(10, 4), {
    operations: { advanced: 20, simple: 7 }, processed: 2, published: 1, requests: 30, errors: 1,
  });
  assert.deepEqual(usage.blob, { advanced: 10 + 20 + USAGE_RECORD_OPERATIONS.advanced, simple: 7 + USAGE_RECORD_OPERATIONS.simple });
  assert.deepEqual(usage.cron, { runs: 1, processed: 2, published: 1, requests: 30, errors: 1 });
  assert.equal(usage.bootstrap.advanced, 4);
});
