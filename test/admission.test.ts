import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVE_USER_LIMIT,
  NEW_USER_LIMIT,
  NEW_USER_WINDOW_MS,
  admissionDecision,
  admitUser,
  clearAdmissionFailures,
  expiredFailures,
  FAILED_RETENTION_MS,
  markAdmissionFailures,
  markUserRemoved,
  removeAdmissions,
  restoreRemovedUser,
} from "../src/hosting/admission-policy.js";
import {
  ADMISSIONS_SCHEMA_VERSION,
  ADMISSIONS_UPDATE_ATTEMPTS,
  emptyAdmissions,
  readAdmissions,
  updateAdmissions,
  type Admissions,
} from "../src/storage/admissions.js";
import { ADMISSIONS_PATHNAME } from "../src/storage/pathnames.js";
import { MemoryObjectStore } from "./helpers/memory-object-store.js";

const NOW = new Date("2026-10-01T12:00:00.000Z");

/** `count`명을 `ageMs` 전에 등록한 기록을 만듭니다. `failed`이면 모두 실패 표시합니다. */
function admissions(count: number, ageMs: number, failed = false, prefix = "user"): Admissions {
  const at = new Date(NOW.getTime() - ageMs).toISOString();
  return {
    schemaVersion: ADMISSIONS_SCHEMA_VERSION,
    users: Object.fromEntries(Array.from({ length: count }, (_, index) => [
      `${prefix}${index}`, { admittedAt: at, failedAt: failed ? at : null, removedAt: null },
    ])),
  };
}

function merge(...records: Admissions[]): Admissions {
  return { schemaVersion: ADMISSIONS_SCHEMA_VERSION, users: Object.assign({}, ...records.map((record) => record.users)) };
}

test("new users are admitted until the rolling 24-hour limit is reached, including failed users", () => {
  assert.equal(admissionDecision(emptyAdmissions(), "alice", NOW), "open");
  assert.equal(admissionDecision(admissions(NEW_USER_LIMIT - 1, 0), "alice", NOW), "open");
  assert.equal(admissionDecision(admissions(NEW_USER_LIMIT, 0), "alice", NOW), "capacity");
  assert.equal(admissionDecision(admissions(NEW_USER_LIMIT, 0, true), "alice", NOW), "capacity");
  assert.equal(admissionDecision(admissions(NEW_USER_LIMIT, NEW_USER_WINDOW_MS - 1), "alice", NOW), "capacity");
  assert.equal(admissionDecision(admissions(NEW_USER_LIMIT, NEW_USER_WINDOW_MS), "alice", NOW), "open");
});

test("the active limit counts only users without a failure mark", () => {
  const old = NEW_USER_WINDOW_MS * 2;
  assert.equal(admissionDecision(admissions(ACTIVE_USER_LIMIT, old), "alice", NOW), "capacity");
  assert.equal(admissionDecision(admissions(ACTIVE_USER_LIMIT - 1, old), "alice", NOW), "open");
  const withFailed = merge(admissions(ACTIVE_USER_LIMIT - 1, old), admissions(10, old, true, "ghost"));
  assert.equal(admissionDecision(withFailed, "alice", NOW), "open");
});

test("registered users keep their state regardless of the limits", () => {
  const full = merge(admissions(ACTIVE_USER_LIMIT, 0), admissions(1, 0, true, "ghost"));
  assert.equal(admissionDecision(full, "user0", NOW), "admitted");
  assert.equal(admissionDecision(full, "ghost0", NOW), "failed");
  assert.equal(admitUser(full, "user0", NOW), null);
  assert.equal(admitUser(full, "alice", NOW), null);
  // 객체 prototype의 이름은 등록된 사용자로 보지 않습니다.
  assert.equal(admissionDecision(emptyAdmissions(), "constructor", NOW), "open");
});

test("admission transitions record, mark, and clear failures only when something changes", () => {
  const admitted = admitUser(emptyAdmissions(), "alice", NOW)!;
  assert.deepEqual(admitted.users.alice, { admittedAt: NOW.toISOString(), failedAt: null, removedAt: null });
  const failed = markAdmissionFailures(admitted, ["alice"], NOW)!;
  assert.equal(failed.users.alice?.failedAt, NOW.toISOString());
  // 이미 표시된 사용자는 처음 표시한 시각을 유지하고, 등록되지 않은 사용자는 무시합니다.
  assert.equal(markAdmissionFailures(failed, ["alice"], new Date(NOW.getTime() + 1_000)), null);
  assert.equal(markAdmissionFailures(admitted, ["bob"], NOW), null);
  const both = markAdmissionFailures(admitUser(admitted, "bob", NOW)!, ["alice", "bob", "carol"], NOW)!;
  assert.deepEqual(Object.keys(both.users).sort(), ["alice", "bob"]);
  assert.ok(Object.values(both.users).every((admission) => admission.failedAt === NOW.toISOString()));
  const cleared = clearAdmissionFailures(failed, ["alice", "bob"])!;
  assert.deepEqual(cleared.users.alice, { admittedAt: NOW.toISOString(), failedAt: null, removedAt: null });
  assert.equal(clearAdmissionFailures(cleared, ["alice"]), null);
  assert.equal(admitted.users.alice?.failedAt, null, "transitions do not mutate their input");
});

test("admissions are read as empty when absent and rejected when corrupted", async () => {
  const store = new MemoryObjectStore("private");
  assert.deepEqual(await readAdmissions(store), { admissions: emptyAdmissions(), etag: null });
  const corrupted = [
    "{",
    JSON.stringify({ schemaVersion: 2, users: {} }),
    JSON.stringify({ schemaVersion: 1, users: [] }),
    JSON.stringify({ schemaVersion: 1, users: { Alice: { admittedAt: NOW.toISOString(), failedAt: null } } }),
    JSON.stringify({ schemaVersion: 1, users: { "bad--name": { admittedAt: NOW.toISOString(), failedAt: null } } }),
    JSON.stringify({ schemaVersion: 1, users: { alice: { admittedAt: "later", failedAt: null } } }),
    JSON.stringify({ schemaVersion: 1, users: { alice: { admittedAt: NOW.toISOString() } } }),
    JSON.stringify({ schemaVersion: 1, users: { alice: { admittedAt: NOW.toISOString(), failedAt: null, removedAt: "soon" } } }),
  ];
  for (const body of corrupted) {
    store.objects.set(ADMISSIONS_PATHNAME, { body, etag: '"x"', uploadedAt: NOW, contentType: "application/json", cacheControlMaxAge: 60 });
    await assert.rejects(readAdmissions(store), /Admissions/, body);
  }
  await assert.rejects(readAdmissions(new MemoryObjectStore("public")), /private store/);

  // 삭제 표시가 생기기 전에 쓴 항목은 표시 없음으로 읽습니다.
  const legacy = JSON.stringify({ schemaVersion: 1, users: { alice: { admittedAt: NOW.toISOString(), failedAt: null } } });
  store.objects.set(ADMISSIONS_PATHNAME, { body: legacy, etag: '"x"', uploadedAt: NOW, contentType: "application/json", cacheControlMaxAge: 60 });
  assert.equal((await readAdmissions(store)).admissions.users.alice?.removedAt, null);
});

test("removed users are blocked, excluded from both limits, and can be restored as new users", () => {
  const full = admissions(NEW_USER_LIMIT - 1, 0);
  const removed = markUserRemoved(markUserRemoved(full, "user0", NOW)!, "stranger", NOW)!;
  assert.equal(admissionDecision(removed, "user0", NOW), "removed");
  assert.equal(admissionDecision(removed, "stranger", NOW), "removed");
  assert.equal(removed.users.user0?.admittedAt, full.users.user0?.admittedAt, "removal keeps the original admission time");
  assert.equal(markUserRemoved(removed, "user0", NOW), null);
  assert.equal(admitUser(removed, "user0", NOW), null, "a removed user is not re-admitted");
  // 삭제 표시된 두 사용자는 세지 않으므로 신규 등록 자리가 두 개 남습니다.
  assert.equal(admissionDecision(removed, "newcomer", NOW), "open");
  // active도 삭제 표시를 빼고 user1~3만 세므로, 오래된 사용자를 상한 바로 아래까지 채워도 자리가 남습니다.
  const nearlyActive = merge(removed, admissions(ACTIVE_USER_LIMIT - 4, NEW_USER_WINDOW_MS, false, "old"));
  assert.equal(admissionDecision(nearlyActive, "newcomer", NOW), "open");

  const restored = restoreRemovedUser(removed, "stranger")!;
  assert.equal(restored.users.stranger, undefined);
  assert.equal(admissionDecision(restored, "stranger", NOW), "open");
  assert.equal(restoreRemovedUser(restored, "stranger"), null);
  assert.equal(restoreRemovedUser(restored, "user1"), null, "only removed users are restored");
});

test("failed unpublished users expire after the retention period", () => {
  const at = (ms: number) => new Date(NOW.getTime() - ms);
  const entry = (failedAgo: number | null, removed = false) => ({
    admittedAt: at(FAILED_RETENTION_MS * 3).toISOString(),
    failedAt: failedAgo === null ? null : at(failedAgo).toISOString(),
    removedAt: removed ? NOW.toISOString() : null,
  });
  const record: Admissions = {
    schemaVersion: ADMISSIONS_SCHEMA_VERSION,
    users: {
      fresh: entry(FAILED_RETENTION_MS - 1),
      edge: entry(FAILED_RETENTION_MS),
      old: entry(FAILED_RETENTION_MS * 2),
      published: entry(FAILED_RETENTION_MS * 2),
      blocked: entry(FAILED_RETENTION_MS * 2, true),
      healthy: entry(null),
    },
  };
  const expired = expiredFailures(record, new Set(["published"]), NOW);
  assert.deepEqual(expired, ["edge", "old"]);
  const pruned = removeAdmissions(record, [...expired, "missing"])!;
  assert.deepEqual(Object.keys(pruned.users).sort(), ["blocked", "fresh", "healthy", "published"]);
  assert.equal(removeAdmissions(pruned, ["missing"]), null);
});

test("admission updates write conditionally, skip unchanged records, and retry after conflicts", async () => {
  const store = new MemoryObjectStore("private");
  const first = await updateAdmissions(store, (current) => admitUser(current, "alice", NOW));
  assert.ok(first.users.alice);
  assert.deepEqual((await readAdmissions(store)).admissions, first);

  const write = store.write.bind(store);
  let writes = 0;
  store.write = async (...args) => { writes += 1; return write(...args); };
  await updateAdmissions(store, () => null);
  assert.equal(writes, 0);

  // 첫 쓰기 직전에 다른 실행이 bob을 등록하면 다시 읽어 두 사용자를 모두 남깁니다.
  let raced = false;
  const read = store.read.bind(store);
  store.read = async (...args) => {
    const stored = await read(...args);
    if (!raced) {
      raced = true;
      await write(ADMISSIONS_PATHNAME, JSON.stringify(admitUser(first, "bob", NOW)), {
        contentType: "application/json", cacheControlMaxAge: 60, condition: { kind: "match", etag: stored!.etag },
      });
    }
    return stored;
  };
  const merged = await updateAdmissions(store, (current) => admitUser(current, "carol", NOW));
  assert.deepEqual(Object.keys(merged.users).sort(), ["alice", "bob", "carol"]);

  store.read = read;
  writes = 0;
  store.write = async () => { writes += 1; return null; };
  await assert.rejects(updateAdmissions(store, (current) => admitUser(current, "dave", NOW)), /concurrently/);
  assert.equal(writes, ADMISSIONS_UPDATE_ATTEMPTS);
});
