import assert from "node:assert/strict";
import test from "node:test";
import { bootstrapUser } from "../src/hosting/bootstrap.js";
import { cardResponse } from "../src/hosting/card-response.js";
import { cronResponse } from "../src/hosting/cron-response.js";
import { CRON_MIN_USER_BUDGET_MS } from "../src/hosting/cron-run.js";
import { runRefreshJob } from "../src/hosting/refresh-job.js";
import { refreshFixture } from "./helpers/refresh-fixture.js";

const SECRET = "log-test-secret";

/** `run` 동안 Function 로그 줄을 원문 그대로 모읍니다. */
async function captureLines(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = { log: console.log, error: console.error };
  const collect = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  console.log = collect;
  console.error = collect;
  try {
    await run();
  } finally {
    console.log = original.log;
    console.error = original.error;
  }
  return lines;
}

test("card, bootstrap, and cron logs are single-line JSON events without usernames or secrets", async () => {
  const f = refreshFixture();
  f.missing.add("ghost-user");
  const lines = await captureLines(async () => {
    await cardResponse(new Request("https://example.test/Alpha-User/stats.svg"), f.dependencies.stores);
    await cardResponse(new Request("https://example.test/alpha-user/stats.svg"), f.dependencies.stores);
    await bootstrapUser("alpha-user", new Date(f.clock.now + 20_000), f.dependencies);
    await bootstrapUser("ghost-user", new Date(f.clock.now + 20_000), f.dependencies);
    await cardResponse(new Request("https://example.test/alpha-user/languages.svg"), f.dependencies.stores);
    await runRefreshJob("beta-user", { deadline: new Date(f.clock.now + 60_000), maxRequests: 0 }, f.dependencies);
    await cronResponse(
      new Request("https://example.test/api/cron", { headers: { Authorization: `Bearer ${SECRET}` } }),
      { secret: SECRET, dependencies: f.dependencies },
      () => ({ deadline: new Date(f.clock.now + 120_000), maxRequests: 100, userBudgetMs: 60_000, minUserBudgetMs: CRON_MIN_USER_BUDGET_MS }),
    );
  });
  const events = lines.map((line) => {
    assert.equal(line.includes("\n"), false);
    return JSON.parse(line) as Record<string, unknown>;
  });
  for (const line of lines) {
    for (const secret of ["alpha-user", "ghost-user", "beta-user", SECRET]) {
      assert.equal(line.toLowerCase().includes(secret), false, line);
    }
  }
  assert.deepEqual(events.filter((event) => event.event === "card.response").map(({ card, status }) => [card, status]), [
    ["stats", "redirect"], ["stats", "pending"], ["languages", "ready"],
  ]);
  const bootstraps = events.filter((event) => event.event === "bootstrap.completed");
  assert.deepEqual(bootstraps.map(({ status }) => status), ["ready", "failed"]);
  for (const event of bootstraps) {
    assert.equal(typeof event.blobAdvanced, "number");
    assert.ok((event.requests as number) > 0);
  }
  const cron = events.find((event) => event.event === "cron.completed");
  assert.equal(cron?.level, "info");
  assert.equal(cron?.published, 1);
  assert.equal(typeof cron?.blobAdvanced, "number");
  assert.equal(cron?.dailyBudget, 60);
});
