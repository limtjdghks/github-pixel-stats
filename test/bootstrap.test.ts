import assert from "node:assert/strict";
import test from "node:test";
import { BOOTSTRAP_MAX_REQUESTS, bootstrapUser } from "../src/hosting/bootstrap.js";
import { boundedDeadline } from "../src/hosting/invocation-deadline.js";
import { readManifest } from "../src/storage/private-repository.js";
import { REFRESH_NOW, refreshFixture } from "./helpers/refresh-fixture.js";

const deadline = (now: number) => new Date(now + 20_000);

test("bootstrap collects a small user and publishes in the same invocation", async () => {
  const f = refreshFixture();
  await bootstrapUser("Fixture-User", deadline(REFRESH_NOW), f.dependencies);
  assert.ok(await readManifest(f.privateStore, "fixture-user"));
  assert.ok(f.calls.length <= BOOTSTRAP_MAX_REQUESTS);
});

test("bootstrap stops at its request limit and later invocations continue the saved checkpoint", async () => {
  const f = refreshFixture();
  const request = f.dependencies.github.requestPage;
  // 상세 페이지가 많아 한 번의 bootstrap 한도를 넘는 사용자를 흉내 냅니다.
  f.dependencies.github.requestPage = async (page, signal) => {
    const result = await request(page, signal);
    return result.kind === "files" ? { ...result, hasNext: page.kind === "files" && page.page < 30 } : result;
  };
  await bootstrapUser("fixture-user", deadline(REFRESH_NOW), f.dependencies);
  assert.equal(f.calls.length, BOOTSTRAP_MAX_REQUESTS);
  assert.equal(await readManifest(f.privateStore, "fixture-user"), null);
  await bootstrapUser("fixture-user", deadline(REFRESH_NOW), f.dependencies);
  assert.equal(f.calls.length, BOOTSTRAP_MAX_REQUESTS * 2);
  assert.equal(f.calls.filter((page) => page.kind === "profile").length, 1);
});

test("bootstrap does not retry failed users and swallows storage errors", async () => {
  const f = refreshFixture();
  f.missing.add("ghost");
  const messages: unknown[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { messages.push(args); };
  try {
    await bootstrapUser("ghost", deadline(REFRESH_NOW), f.dependencies);
    const count = f.calls.length;
    await bootstrapUser("ghost", deadline(REFRESH_NOW), f.dependencies);
    assert.equal(f.calls.length, count);

    f.dependencies.checkpoints.load = async () => { throw new Error("checkpoint unavailable"); };
    await bootstrapUser("other", deadline(REFRESH_NOW), f.dependencies);
    assert.deepEqual(messages, [["Bootstrap failed:", "checkpoint unavailable"]]);
  } finally {
    console.error = originalError;
  }
});

test("background deadlines use the earlier of the budget and the invocation deadline minus a margin", () => {
  const now = new Date(REFRESH_NOW);
  assert.equal(boundedDeadline(now, 20_000, undefined, 2_000).getTime(), REFRESH_NOW + 20_000);
  assert.equal(boundedDeadline(now, 20_000, new Date(REFRESH_NOW + 30_000), 2_000).getTime(), REFRESH_NOW + 20_000);
  assert.equal(boundedDeadline(now, 20_000, new Date(REFRESH_NOW + 10_000), 2_000).getTime(), REFRESH_NOW + 8_000);
});
