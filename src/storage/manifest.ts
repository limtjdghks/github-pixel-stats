import { isMascotId, type MascotId } from "../render/index.js";
import { parseUsername, usernamesEqual } from "../username.js";
import { isReleaseVersion, releasePathnames } from "./pathnames.js";

export const MANIFEST_SCHEMA_VERSION = 1 as const;

/**
 * 발행된 카드 묶음입니다. pathname은 저장하지 않고 `releasePathnames()`로 다시 만듭니다.
 * `mascots`는 현재 registry에 있는 ID만 담으며, 모두 제거된 오래된 release에서는 비어 있을 수 있습니다.
 */
export interface CardRelease {
  version: string;
  generatedAt: string;
  mascots: MascotId[];
}

/** previous에서 밀려난 release입니다. `retiredAt`부터 유예 시간 동안 객체를 보존합니다. */
export interface RetiredRelease extends CardRelease {
  retiredAt: string;
}

/**
 * 사용자별로 하나뿐인 변경 가능한 private 객체입니다.
 * 최신 성공(current)과 직전 성공(previous)을 제공 대상으로, 유예 중인 퇴역 release(retired)를 보존 대상으로 가리킵니다.
 */
export interface CardManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  username: string;
  publishedAt: string;
  current: CardRelease;
  previous: CardRelease | null;
  retired: RetiredRelease[];
}

/**
 * 참조가 끊긴 release를 지우기 전 유예 시간입니다.
 * 버전 경로를 cache한 클라이언트와 아직 manifest에 반영되지 않은 다른 발행을 보호하며,
 * 발행 한 번에 걸리는 최대 시간(현재 Function maxDuration 10초)보다 충분히 길어야 합니다.
 */
export const RELEASE_GRACE_MS = 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/**
 * 저장된 release를 검증합니다.
 * 이후 배포에서 registry에서 빠진 마스코트는 오류 대신 목록에서 제외해 기존 manifest를 계속 읽을 수 있게 합니다.
 * 제외된 variant 카드는 참조에서 빠지므로 다음 정리 단계에서 삭제됩니다.
 */
function parseRelease(value: unknown): CardRelease {
  if (
    !isRecord(value) ||
    !isReleaseVersion(value.version) ||
    !isTimestamp(value.generatedAt) ||
    !Array.isArray(value.mascots) ||
    value.mascots.length === 0 ||
    !value.mascots.every((id) => typeof id === "string" && id.length > 0) ||
    new Set(value.mascots).size !== value.mascots.length
  ) {
    throw new Error("Manifest has an invalid release.");
  }
  return { version: value.version, generatedAt: value.generatedAt, mascots: value.mascots.filter(isMascotId) };
}

function parseRetired(value: unknown): RetiredRelease {
  if (!isRecord(value) || !isTimestamp(value.retiredAt)) {
    throw new Error("Manifest has an invalid retired release.");
  }
  return { ...parseRelease(value), retiredAt: value.retiredAt };
}

/** 저장소에서 읽은 manifest를 검증합니다. 다른 사용자나 손상된 구조는 오류로 처리합니다. */
export function parseManifest(value: unknown, expectedUsername: string): CardManifest {
  if (!isRecord(value) || value.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error("Manifest has an unsupported shape.");
  }
  if (typeof value.username !== "string" || value.username !== parseUsername(value.username) ||
    !usernamesEqual(value.username, expectedUsername)) {
    throw new Error("Manifest has an unexpected username.");
  }
  if (!isTimestamp(value.publishedAt)) {
    throw new Error("Manifest has an invalid publishedAt.");
  }
  if (!Array.isArray(value.retired)) {
    throw new Error("Manifest has an invalid retired list.");
  }
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    username: value.username,
    publishedAt: value.publishedAt,
    current: parseRelease(value.current),
    previous: value.previous === null ? null : parseRelease(value.previous),
    retired: value.retired.map(parseRetired),
  };
}

/**
 * 새 release를 current로 하는 다음 manifest를 만듭니다.
 * 기존 previous는 `now`에 퇴역 처리하고, 퇴역 후 유예 시간이 지난 release는 목록에서 뺍니다.
 * 목록에서 빠진 release는 참조가 없어지므로 정리 단계에서 삭제됩니다.
 */
export function nextManifest(
  existing: CardManifest | null,
  username: string,
  release: CardRelease,
  now: Date,
  graceMs = RELEASE_GRACE_MS,
): CardManifest {
  const cutoff = now.getTime() - graceMs;
  const retired = [
    ...(existing?.retired ?? []),
    ...(existing?.previous ? [{ ...existing.previous, retiredAt: now.toISOString() }] : []),
  ].filter((entry) => Date.parse(entry.retiredAt) > cutoff &&
    entry.version !== release.version && entry.version !== existing?.current.version);
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    username,
    publishedAt: now.toISOString(),
    current: release,
    previous: existing?.current ?? null,
    retired,
  };
}

/** manifest가 보존해야 하는 private·public pathname 목록입니다. 유예 중인 퇴역 release도 포함합니다. */
export function referencedPathnames(manifest: CardManifest): { private: Set<string>; public: Set<string> } {
  const references = { private: new Set<string>(), public: new Set<string>() };
  for (const release of [manifest.current, manifest.previous, ...manifest.retired]) {
    if (release === null) continue;
    const pathnames = releasePathnames(manifest.username, release.version, release.mascots);
    references.private.add(pathnames.private.snapshot).add(pathnames.private.state);
    references.public.add(pathnames.public.languages);
    for (const pathname of Object.values(pathnames.public.stats)) {
      references.public.add(pathname);
    }
  }
  return references;
}
