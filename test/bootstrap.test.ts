import assert from "node:assert/strict";
import test from "node:test";
import { GitHubRequestError } from "../src/data/github-pages.js";
import { NEW_USER_LIMIT, admitUser } from "../src/hosting/admission-policy.js";
import { BOOTSTRAP_MAX_REQUESTS, bootstrapUser } from "../src/hosting/bootstrap.js";
import { boundedDeadline } from "../src/hosting/invocation-deadline.js";
import { runRefreshJob } from "../src/hosting/refresh-job.js";
import { readAdmissions, updateAdmissions } from "../src/storage/admissions.js";
import { CHECKPOINT_PREFIX } from "../src/storage/pathnames.js";
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
    assert.equal((await readAdmissions(f.privateStore)).admissions.users.ghost?.failedAt, new Date(REFRESH_NOW).toISOString());
    await bootstrapUser("ghost", deadline(REFRESH_NOW), f.dependencies);
    assert.equal(f.calls.length, count);

    f.dependencies.checkpoints.load = async () => { throw new Error("checkpoint unavailable"); };
    await bootstrapUser("other", deadline(REFRESH_NOW), f.dependencies);
    assert.deepEqual(messages.map((args) => JSON.parse((args as string[])[0]!)), [
      { level: "error", event: "bootstrap.failed", error: "checkpoint unavailable" },
    ]);
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

test("a transient GitHub failure or rate limit during bootstrap resumes on a later card request", async () => {
  for (const error of [
    new GitHubRequestError("GitHub API 502", null, 502),
    new GitHubRequestError("rate limited", 30 * 60_000, 403),
  ]) {
    const f = refreshFixture();
    const request = f.dependencies.github.requestPage;
    f.dependencies.github.requestPage = async () => { throw error; };
    await bootstrapUser("fixture-user", deadline(REFRESH_NOW), f.dependencies);
    assert.equal(await readManifest(f.privateStore, "fixture-user"), null);

    f.dependencies.github.requestPage = request;
    f.clock.now += 30 * 60_000;
    await bootstrapUser("fixture-user", deadline(f.clock.now), f.dependencies);
    assert.ok(await readManifest(f.privateStore, "fixture-user"), error.message);
  }
});

test("bootstrap registers new users and stops without GitHub requests once the new-user limit is reached", async () => {
  const f = refreshFixture();
  const now = new Date(REFRESH_NOW);
  await updateAdmissions(f.privateStore, (current) => {
    let next = current;
    for (let index = 0; index < NEW_USER_LIMIT; index += 1) next = admitUser(next, `user${index}`, now)!;
    return next;
  });
  await bootstrapUser("late-user", deadline(REFRESH_NOW), f.dependencies);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.privateStore.list(CHECKPOINT_PREFIX), []);
  assert.equal(Object.hasOwn((await readAdmissions(f.privateStore)).admissions.users, "late-user"), false);

  // 이미 등록된 사용자는 상한과 관계없이 수집합니다.
  await bootstrapUser("User0", deadline(REFRESH_NOW), f.dependencies);
  assert.ok(await readManifest(f.privateStore, "user0"));
});

test("concurrent bootstraps competing for the last new-user slot register exactly one user", async () => {
  const f = refreshFixture();
  const now = new Date(REFRESH_NOW);
  await updateAdmissions(f.privateStore, (current) => {
    let next = current;
    for (let index = 0; index < NEW_USER_LIMIT - 1; index += 1) next = admitUser(next, `user${index}`, now)!;
    return next;
  });
  // 경쟁자 수를 조건부 쓰기 재시도 횟수보다 적게 둬, 재시도가 바닥나서가 아니라 상한 판정으로 멈추는지 확인합니다.
  const write = f.privateStore.write.bind(f.privateStore);
  let conflicts = 0;
  f.privateStore.write = async (...args) => {
    const etag = await write(...args);
    if (etag === null) conflicts += 1;
    return etag;
  };
  const usernames = ["crowd0", "crowd1", "crowd2"];
  await Promise.all(usernames.map((username) => bootstrapUser(username, deadline(REFRESH_NOW), f.dependencies)));
  assert.ok(conflicts > 0, "bootstraps must actually race on the admission record");
  const users = (await readAdmissions(f.privateStore)).admissions.users;
  const admitted = usernames.filter((username) => Object.hasOwn(users, username));
  assert.equal(admitted.length, 1);
  assert.equal(Object.keys(users).length, NEW_USER_LIMIT);
  const collected = new Set(f.calls.filter((page) => page.kind === "profile").map((page) => page.username));
  assert.deepEqual([...collected], admitted);
});

test("bootstrap marks a registered user whose checkpoint already failed without GitHub requests", async () => {
  const f = refreshFixture();
  f.missing.add("ghost");
  const now = new Date(REFRESH_NOW);
  await updateAdmissions(f.privateStore, (current) => admitUser(current, "ghost", now));
  // Cron처럼 bootstrap 밖에서 수집이 실패해 등록 기록에는 표시가 없는 상태를 만듭니다.
  const failed = await runRefreshJob("ghost", { deadline: deadline(REFRESH_NOW), maxRequests: 10 }, f.dependencies);
  assert.equal(failed.status, "failed");
  const calls = f.calls.length;
  assert.equal((await readAdmissions(f.privateStore)).admissions.users.ghost?.failedAt, null);

  await bootstrapUser("ghost", deadline(REFRESH_NOW), f.dependencies);
  assert.equal(f.calls.length, calls);
  assert.equal((await readAdmissions(f.privateStore)).admissions.users.ghost?.failedAt, now.toISOString());
});
