import type { Admission, Admissions } from "../storage/admissions.js";

/**
 * 신규 등록 상한을 세는 기간과 상한입니다. 기간은 UTC 날짜가 아니라 등록 시각 기준 최근 24시간입니다.
 * 실패한 사용자도 세므로, 존재하지 않는 사용자명으로 GitHub를 호출하는 bootstrap도 기간마다 이 수까지만 생깁니다.
 */
export const NEW_USER_WINDOW_MS = 24 * 60 * 60 * 1000;
export const NEW_USER_LIMIT = 5;
/**
 * 실패 표시가 없는 등록 사용자의 상한입니다(epic 초기 권장값).
 * 실패 표시된 사용자는 세지 않아, 존재하지 않는 사용자명이 자리를 영구히 차지하지 않습니다.
 * 이 상한은 Cron 작업량의 상한이 아닙니다. 실패한 미발행 사용자도 HOST-11 정리 전까지 Cron 재시도 대상으로 남습니다.
 */
export const ACTIVE_USER_LIMIT = 20;
/**
 * 실패 표시 후 미발행 사용자의 checkpoint와 등록 항목을 보존하는 기간입니다. 그동안 Cron이 매일 다시 수집하며,
 * 지난 뒤 지워진 사용자는 다음 카드 요청에서 신규 사용자로 다시 등록됩니다.
 */
export const FAILED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 발행 카드가 없는 사용자의 등록 상태입니다.
 * - `admitted`: 등록됨. bootstrap을 진행합니다.
 * - `failed`: 등록됐지만 수집이 실패했습니다. 카드 요청으로 다시 수집하지 않습니다.
 * - `open`: 등록되지 않았고 상한에 여유가 있습니다.
 * - `capacity`: 등록되지 않았고 상한에 도달했습니다.
 * - `removed`: 운영자가 데이터를 삭제하고 재수집을 막았습니다. 해제할 때까지 수집하지 않습니다.
 */
export type AdmissionDecision = "admitted" | "failed" | "open" | "capacity" | "removed";

// 사용자 key가 `constructor`처럼 Object prototype 이름이어도 상속된 값을 등록 항목으로 읽지 않습니다.
function entryOf(admissions: Admissions, key: string): Admission | undefined {
  return Object.hasOwn(admissions.users, key) ? admissions.users[key] : undefined;
}

/** 삭제 표시된 사용자는 서비스를 쓰지 않으므로 신규·active 상한 어느 쪽에도 세지 않습니다. */
export function admissionDecision(admissions: Admissions, key: string, now: Date): AdmissionDecision {
  const entry = entryOf(admissions, key);
  if (entry !== undefined) {
    if (entry.removedAt !== null) return "removed";
    return entry.failedAt === null ? "admitted" : "failed";
  }
  const windowStart = now.getTime() - NEW_USER_WINDOW_MS;
  const entries = Object.values(admissions.users).filter((admission) => admission.removedAt === null);
  const recent = entries.filter((admission) => Date.parse(admission.admittedAt) > windowStart).length;
  const active = entries.filter((admission) => admission.failedAt === null).length;
  return recent >= NEW_USER_LIMIT || active >= ACTIVE_USER_LIMIT ? "capacity" : "open";
}

/** `open`인 사용자를 등록한 기록을 반환합니다. 그 외 상태이면 바꿀 것이 없으므로 null입니다. */
export function admitUser(admissions: Admissions, key: string, now: Date): Admissions | null {
  if (admissionDecision(admissions, key, now) !== "open") return null;
  return { ...admissions, users: { ...admissions.users, [key]: { admittedAt: now.toISOString(), failedAt: null, removedAt: null } } };
}

/** 등록된 사용자 중 실패 표시 여부가 `failedAt`과 다른 사용자만 바꿉니다. 바뀐 사용자가 없으면 null입니다. */
function withFailedAt(admissions: Admissions, keys: readonly string[], failedAt: string | null): Admissions | null {
  const users = { ...admissions.users };
  let changed = false;
  for (const key of keys) {
    const entry = entryOf(admissions, key);
    if (entry === undefined || (entry.failedAt === null) === (failedAt === null)) continue;
    users[key] = { ...entry, failedAt };
    changed = true;
  }
  return changed ? { ...admissions, users } : null;
}

/** 등록된 사용자에 실패를 표시합니다. 이미 표시된 사용자는 처음 표시한 시각을 유지하며, 바꿀 것이 없으면 null입니다. */
export function markAdmissionFailures(admissions: Admissions, keys: readonly string[], now: Date): Admissions | null {
  return withFailedAt(admissions, keys, now.toISOString());
}

/**
 * 발행된 사용자의 실패 표시를 지웁니다. 지울 것이 없으면 null입니다.
 * 상한과 관계없이 지우므로, 실패 후 회복한 사용자만큼 active 수가 일시적으로 상한을 넘을 수 있습니다.
 */
export function clearAdmissionFailures(admissions: Admissions, keys: readonly string[]): Admissions | null {
  return withFailedAt(admissions, keys, null);
}

/**
 * 사용자에 삭제 표시를 남깁니다. 등록되지 않은 사용자도 표시해 이후 카드 요청이 수집을 시작하지 않게 합니다.
 * 이미 표시돼 있으면 null입니다.
 */
export function markUserRemoved(admissions: Admissions, key: string, now: Date): Admissions | null {
  const entry = entryOf(admissions, key);
  if (entry?.removedAt != null) return null;
  const at = now.toISOString();
  return { ...admissions, users: { ...admissions.users, [key]: { admittedAt: entry?.admittedAt ?? at, failedAt: null, removedAt: at } } };
}

/** 삭제 표시를 풀고 등록 항목을 지웁니다. 다음 카드 요청부터 신규 사용자로 상한 안에서 다시 등록됩니다. 표시가 없으면 null입니다. */
export function restoreRemovedUser(admissions: Admissions, key: string): Admissions | null {
  if (entryOf(admissions, key)?.removedAt == null) return null;
  return removeAdmissions(admissions, [key]);
}

/**
 * 실패 표시 후 `FAILED_RETENTION_MS`가 지난 미발행 사용자 key입니다. `published`에 든(manifest가 있는) 사용자와
 * 삭제 표시된 사용자는 제외합니다.
 */
export function expiredFailures(admissions: Admissions, published: ReadonlySet<string>, now: Date): string[] {
  const cutoff = now.getTime() - FAILED_RETENTION_MS;
  return Object.entries(admissions.users)
    .filter(([key, entry]) => entry.removedAt === null && entry.failedAt !== null &&
      Date.parse(entry.failedAt) <= cutoff && !published.has(key))
    .map(([key]) => key)
    .sort();
}

/** 등록 항목을 지웁니다. 지울 항목이 없으면 null입니다. */
export function removeAdmissions(admissions: Admissions, keys: readonly string[]): Admissions | null {
  const present = keys.filter((key) => entryOf(admissions, key) !== undefined);
  if (present.length === 0) return null;
  const users = { ...admissions.users };
  for (const key of present) delete users[key];
  return { ...admissions, users };
}
