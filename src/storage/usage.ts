import type { ObjectStore } from "./object-store.js";
import { usageDateKey, usagePathname } from "./pathnames.js";
import { JSON_CONTENT_TYPE, PRIVATE_CACHE_SECONDS } from "./private-repository.js";

export const USAGE_SCHEMA_VERSION = 1 as const;

/** 조건부 교체가 다른 실행과 계속 충돌할 때 포기하기 전까지 다시 읽는 횟수입니다. */
export const USAGE_UPDATE_ATTEMPTS = 5;

/**
 * UTC 하루 동안 Cron과 bootstrap이 쓴 자원의 누적 기록입니다. 카드 응답 경로는 저장소에 쓰지 않으므로
 * 카드 조회의 Blob 읽기는 들어 있지 않습니다. `blob`은 Cron·bootstrap 합계이며 `bootstrap.advanced`는 그중 bootstrap 몫입니다.
 */
export interface DailyUsage {
  schemaVersion: typeof USAGE_SCHEMA_VERSION;
  date: string;
  blob: { advanced: number; simple: number };
  cron: { runs: number; processed: number; published: number; requests: number; errors: number; publishFailures: number };
  bootstrap: { runs: number; published: number; requests: number; advanced: number };
}

export interface StoredUsage {
  usage: DailyUsage;
  /** 객체가 아직 없으면 null입니다. */
  etag: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function counters<K extends string>(value: unknown, keys: readonly K[]): Record<K, number> {
  if (!isRecord(value)) throw new Error("Usage has an invalid counter group.");
  const result = {} as Record<K, number>;
  for (const key of keys) {
    const count = value[key];
    if (!Number.isSafeInteger(count) || (count as number) < 0) throw new Error("Usage has an invalid counter.");
    result[key] = count as number;
  }
  return result;
}

export function emptyUsage(date: Date): DailyUsage {
  return {
    schemaVersion: USAGE_SCHEMA_VERSION,
    date: usageDateKey(date),
    blob: { advanced: 0, simple: 0 },
    cron: { runs: 0, processed: 0, published: 0, requests: 0, errors: 0, publishFailures: 0 },
    bootstrap: { runs: 0, published: 0, requests: 0, advanced: 0 },
  };
}

function parseUsage(value: unknown, date: Date): DailyUsage {
  if (!isRecord(value) || value.schemaVersion !== USAGE_SCHEMA_VERSION || value.date !== usageDateKey(date)) {
    throw new Error("Usage has an invalid shape.");
  }
  return {
    schemaVersion: USAGE_SCHEMA_VERSION,
    date: value.date,
    blob: counters(value.blob, ["advanced", "simple"]),
    // `publishFailures`가 생기기 전에 쓴 기록은 이 필드가 없으므로 0으로 읽습니다.
    cron: counters(isRecord(value.cron) ? { publishFailures: 0, ...value.cron } : value.cron,
      ["runs", "processed", "published", "requests", "errors", "publishFailures"]),
    bootstrap: counters(value.bootstrap, ["runs", "published", "requests", "advanced"]),
  };
}

/** `date`가 속한 날짜의 기록을 읽습니다. 객체가 없으면 빈 기록이며, 손상됐으면 던집니다. */
export async function readUsage(store: ObjectStore, date: Date, signal?: AbortSignal): Promise<StoredUsage> {
  if (store.access !== "private") {
    throw new Error("Usage requires a private store.");
  }
  const stored = await store.read(usagePathname(date), signal);
  if (stored === null) return { usage: emptyUsage(date), etag: null };
  let value: unknown;
  try {
    value = JSON.parse(stored.body);
  } catch {
    throw new Error("Usage is not valid JSON.");
  }
  return { usage: parseUsage(value, date), etag: stored.etag };
}

/**
 * `date`가 속한 날짜의 최신 기록에 `update`를 적용해 조건부로 교체하고 교체한 기록을 반환합니다.
 * 다른 실행과 충돌하면 다시 읽어 `update`를 다시 적용하므로 `update`는 입력 기록만으로 결과를 정해야 합니다.
 * `USAGE_UPDATE_ATTEMPTS`번 모두 충돌하면 던집니다.
 */
export async function updateUsage(
  store: ObjectStore,
  date: Date,
  update: (usage: DailyUsage) => DailyUsage,
  signal?: AbortSignal,
): Promise<DailyUsage> {
  for (let attempt = 0; attempt < USAGE_UPDATE_ATTEMPTS; attempt += 1) {
    signal?.throwIfAborted();
    const { usage, etag } = await readUsage(store, date, signal);
    const next = update(usage);
    const written = await store.write(usagePathname(date), `${JSON.stringify(next)}\n`, {
      contentType: JSON_CONTENT_TYPE,
      cacheControlMaxAge: PRIVATE_CACHE_SECONDS,
      condition: etag === null ? { kind: "absent" } : { kind: "match", etag },
      ...(signal === undefined ? {} : { signal }),
    });
    if (written !== null) return next;
  }
  throw new Error("Usage changed concurrently.");
}

/**
 * `now`보다 `retentionDays`일 이상 지난 날짜의 기록을 지웁니다. delete는 Blob 요금이 없으므로 list 없이
 * 보존 기간 바로 뒤 `sweepDays`일의 pathname을 직접 지우며, 그동안 Cron이 한 번 이상 돌면 빠짐없이 지워집니다.
 */
export async function removeExpiredUsage(store: ObjectStore, now: Date, retentionDays: number, sweepDays: number): Promise<void> {
  const day = 24 * 60 * 60 * 1000;
  const pathnames = Array.from({ length: sweepDays }, (_, offset) =>
    usagePathname(new Date(now.getTime() - (retentionDays + offset) * day)));
  await store.delete(pathnames);
}
