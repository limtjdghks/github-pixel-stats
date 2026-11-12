import type { ObjectStore } from "./object-store.js";
import { ADMISSIONS_PATHNAME, userKey } from "./pathnames.js";
import { JSON_CONTENT_TYPE, PRIVATE_CACHE_SECONDS } from "./private-repository.js";

export const ADMISSIONS_SCHEMA_VERSION = 1 as const;

/** 조건부 교체가 다른 실행과 계속 충돌할 때 포기하기 전까지 다시 읽는 횟수입니다. */
export const ADMISSIONS_UPDATE_ATTEMPTS = 5;

/**
 * `failedAt`은 발행 전 수집이 실패했다는 표시이며, 발행에 성공하면 지웁니다.
 * `removedAt`은 운영자가 사용자 데이터를 삭제하고 재수집을 막았다는 표시이며, 운영자가 해제할 때까지 남습니다.
 */
export interface Admission {
  admittedAt: string;
  failedAt: string | null;
  removedAt: string | null;
}

/**
 * 서비스에 등록된 사용자 전체의 기록입니다. key는 사용자 key(소문자)입니다.
 * 상한을 동시 요청에서도 정확히 지키도록 사용자별 객체가 아닌 단일 객체를 ETag 조건부 교체로만 바꿉니다.
 */
export interface Admissions {
  schemaVersion: typeof ADMISSIONS_SCHEMA_VERSION;
  users: Record<string, Admission>;
}

export interface StoredAdmissions {
  admissions: Admissions;
  /** 객체가 아직 없으면 null입니다. */
  etag: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isUserKey(key: string): boolean {
  try {
    return userKey(key) === key;
  } catch {
    return false;
  }
}

export function emptyAdmissions(): Admissions {
  return { schemaVersion: ADMISSIONS_SCHEMA_VERSION, users: {} };
}

function parseAdmissions(value: unknown): Admissions {
  if (!isRecord(value) || value.schemaVersion !== ADMISSIONS_SCHEMA_VERSION || !isRecord(value.users)) {
    throw new Error("Admissions have an invalid shape.");
  }
  const users: Record<string, Admission> = {};
  for (const [key, entry] of Object.entries(value.users)) {
    // `removedAt`이 생기기 전에 쓴 항목은 이 필드가 없으므로 표시 없음으로 읽습니다.
    const removedAt = isRecord(entry) ? entry.removedAt ?? null : null;
    if (
      !isUserKey(key) || !isRecord(entry) || !isTimestamp(entry.admittedAt) ||
      (entry.failedAt !== null && !isTimestamp(entry.failedAt)) ||
      (removedAt !== null && !isTimestamp(removedAt))
    ) {
      throw new Error("Admissions have an invalid entry.");
    }
    users[key] = { admittedAt: entry.admittedAt, failedAt: entry.failedAt, removedAt };
  }
  return { schemaVersion: ADMISSIONS_SCHEMA_VERSION, users };
}

/** 등록 기록을 읽습니다. 객체가 없으면 빈 기록이며, 손상됐으면 던집니다. */
export async function readAdmissions(store: ObjectStore, signal?: AbortSignal): Promise<StoredAdmissions> {
  if (store.access !== "private") {
    throw new Error("Admissions require a private store.");
  }
  const stored = await store.read(ADMISSIONS_PATHNAME, signal);
  if (stored === null) return { admissions: emptyAdmissions(), etag: null };
  let value: unknown;
  try {
    value = JSON.parse(stored.body);
  } catch {
    throw new Error("Admissions are not valid JSON.");
  }
  return { admissions: parseAdmissions(value), etag: stored.etag };
}

/**
 * 최신 기록에 `update`를 적용해 조건부로 교체하고, 교체 뒤(또는 바꿀 것이 없던) 기록을 반환합니다.
 * `update`가 null을 반환하면 쓰지 않습니다. 다른 실행과 충돌하면 다시 읽어 `update`를 다시 적용하므로
 * `update`는 부작용 없이 입력 기록만으로 결과를 정해야 합니다. `ADMISSIONS_UPDATE_ATTEMPTS`번 모두 충돌하면 던집니다.
 * `signal`이 중단되면 읽기·쓰기를 중단하고 던집니다.
 */
export async function updateAdmissions(
  store: ObjectStore,
  update: (admissions: Admissions) => Admissions | null,
  signal?: AbortSignal,
): Promise<Admissions> {
  for (let attempt = 0; attempt < ADMISSIONS_UPDATE_ATTEMPTS; attempt += 1) {
    signal?.throwIfAborted();
    const { admissions, etag } = await readAdmissions(store, signal);
    const next = update(admissions);
    if (next === null) return admissions;
    const written = await store.write(ADMISSIONS_PATHNAME, `${JSON.stringify(next)}\n`, {
      contentType: JSON_CONTENT_TYPE,
      cacheControlMaxAge: PRIVATE_CACHE_SECONDS,
      condition: etag === null ? { kind: "absent" } : { kind: "match", etag },
      ...(signal === undefined ? {} : { signal }),
    });
    if (written !== null) return next;
  }
  throw new Error("Admissions changed concurrently.");
}
