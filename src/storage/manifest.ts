import { isMascotId, type MascotId } from "../render/index.js";
import { parseUsername, usernamesEqual } from "../username.js";
import { isReleaseVersion, releasePathnames } from "./pathnames.js";

export const MANIFEST_SCHEMA_VERSION = 1 as const;

/** 발행된 카드 묶음입니다. pathname은 저장하지 않고 `releasePathnames()`로 다시 만듭니다. */
export interface CardRelease {
  version: string;
  generatedAt: string;
  mascots: MascotId[];
}

/** 사용자별로 하나뿐인 변경 가능한 private 객체이며, 최신 성공과 직전 성공 release만 가리킵니다. */
export interface CardManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  username: string;
  publishedAt: string;
  current: CardRelease;
  previous: CardRelease | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function parseRelease(value: unknown): CardRelease {
  if (
    !isRecord(value) ||
    !isReleaseVersion(value.version) ||
    !isTimestamp(value.generatedAt) ||
    !Array.isArray(value.mascots) ||
    value.mascots.length === 0 ||
    !value.mascots.every(isMascotId) ||
    new Set(value.mascots).size !== value.mascots.length
  ) {
    throw new Error("Manifest has an invalid release.");
  }
  return { version: value.version, generatedAt: value.generatedAt, mascots: [...value.mascots] };
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
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    username: value.username,
    publishedAt: value.publishedAt,
    current: parseRelease(value.current),
    previous: value.previous === null ? null : parseRelease(value.previous),
  };
}

/** manifest가 보존해야 하는 private·public pathname 목록입니다. */
export function referencedPathnames(manifest: CardManifest): { private: Set<string>; public: Set<string> } {
  const references = { private: new Set<string>(), public: new Set<string>() };
  for (const release of [manifest.current, manifest.previous]) {
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
