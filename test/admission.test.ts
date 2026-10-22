import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVE_USER_LIMIT,
  NEW_USER_LIMIT,
  NEW_USER_WINDOW_MS,
  admissionDecision,
  admitUser,
  clearAdmissionFailures,
  markAdmissionFailures,
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
      `${prefix}${index}`, { admittedAt: at, failedAt: failed ? at : null },
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
  assert.deepEqual(admitted.users.alice, { admittedAt: NOW.toISOString(), failedAt: null });
  const failed = markAdmissionFailures(admitted, ["alice"], NOW)!;
  assert.equal(failed.users.alice?.failedAt, NOW.toISOString());
  // 이미 표시된 사용자는 처음 표시한 시각을 유지하고, 등록되지 않은 사용자는 무시합니다.
  assert.equal(markAdmissionFailures(failed, ["alice"], new Date(NOW.getTime() + 1_000)), null);
  assert.equal(markAdmissionFailures(admitted, ["bob"], NOW), null);
  const both = markAdmissionFailures(admitUser(admitted, "bob", NOW)!, ["alice", "bob", "carol"], NOW)!;
  assert.deepEqual(Object.keys(both.users).sort(), ["alice", "bob"]);
  assert.ok(Object.values(both.users).every((admission) => admission.failedAt === NOW.toISOString()));
  const cleared = clearAdmissionFailures(failed, ["alice", "bob"])!;
  assert.deepEqual(cleared.users.alice, { admittedAt: NOW.toISOString(), failedAt: null });
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
  ];
  for (const body of corrupted) {
    store.objects.set(ADMISSIONS_PATHNAME, { body, etag: '"x"', uploadedAt: NOW, contentType: "application/json", cacheControlMaxAge: 60 });
    await assert.rejects(readAdmissions(store), /Admissions/, body);
  }
  await assert.rejects(readAdmissions(new MemoryObjectStore("public")), /private store/);
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
