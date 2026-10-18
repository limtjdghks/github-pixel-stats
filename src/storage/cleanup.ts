import { referencedPathnames, type CardManifest } from "./manifest.js";
import type { ObjectStore } from "./object-store.js";
import { cardPrefix, releasePrefix } from "./pathnames.js";

/**
 * 아직 manifest에 반영되지 않은 다른 발행의 객체를 지우지 않기 위한 유예 시간입니다.
 * 발행 한 번에 걸리는 최대 시간(현재 Function maxDuration 10초)보다 충분히 길어야 합니다.
 */
export const RELEASE_GRACE_MS = 60 * 60 * 1000;

export interface CleanupReport {
  deleted: number;
}

/**
 * 새 manifest를 발행한 뒤 현재·직전 release가 참조하지 않는 객체를 삭제합니다.
 * 유예 시간보다 최근에 올라온 객체는 진행 중인 다른 발행의 것일 수 있으므로 남깁니다.
 */
export async function removeUnreferencedReleases(
  stores: { private: ObjectStore; public: ObjectStore },
  manifest: CardManifest,
  now: Date,
  graceMs = RELEASE_GRACE_MS,
): Promise<CleanupReport> {
  const references = referencedPathnames(manifest);
  const cutoff = now.getTime() - graceMs;
  const targets = [
    { store: stores.private, prefix: releasePrefix(manifest.username), keep: references.private },
    { store: stores.public, prefix: cardPrefix(manifest.username), keep: references.public },
  ];
  let deleted = 0;
  for (const { store, prefix, keep } of targets) {
    const expired = (await store.list(prefix))
      .filter((entry) => !keep.has(entry.pathname) && entry.uploadedAt.getTime() <= cutoff)
      .map((entry) => entry.pathname);
    await store.delete(expired);
    deleted += expired.length;
  }
  return { deleted };
}
