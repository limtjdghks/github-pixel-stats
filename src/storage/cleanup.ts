import { RELEASE_GRACE_MS, referencedPathnames, type CardManifest } from "./manifest.js";
import type { ObjectStore } from "./object-store.js";
import { cardPrefix, releasePrefix } from "./pathnames.js";
import { readManifest } from "./private-repository.js";

export interface CleanupReport {
  deleted: number;
}

/**
 * 새 manifest를 발행한 뒤 manifest가 참조하지 않는 release 객체를 삭제합니다.
 * 퇴역 release의 유예는 manifest의 `retiredAt`으로 관리하므로, 여기서는 참조 여부만 봅니다.
 * 한 번도 참조되지 않은 객체는 아직 manifest에 반영되지 않은 다른 발행의 것일 수 있어 업로드 후 유예 시간이 지나야 삭제합니다.
 */
export async function removeUnreferencedReleases(
  stores: { private: ObjectStore; public: ObjectStore },
  manifest: CardManifest,
  now: Date,
  graceMs = RELEASE_GRACE_MS,
): Promise<CleanupReport> {
  const cutoff = now.getTime() - graceMs;
  const targets = [
    { store: stores.private, prefix: releasePrefix(manifest.username), scope: "private" as const },
    { store: stores.public, prefix: cardPrefix(manifest.username), scope: "public" as const },
  ];
  const candidates = await Promise.all(targets.map(async ({ store, prefix }) =>
    (await store.list(prefix)).filter((entry) => entry.uploadedAt.getTime() <= cutoff).map((entry) => entry.pathname)));

  // list 이후 다른 발행이 manifest를 바꿨을 수 있으므로 삭제 직전 최신 manifest의 참조도 보존합니다.
  // 최신 manifest 확인과 삭제 사이의 짧은 경합은 남아 있습니다.
  const latest = await readManifest(stores.private, manifest.username);
  const keep = [referencedPathnames(manifest), ...(latest ? [referencedPathnames(latest.manifest)] : [])];
  let deleted = 0;
  for (const [index, { store, scope }] of targets.entries()) {
    const expired = (candidates[index] ?? []).filter((pathname) => keep.every((references) => !references[scope].has(pathname)));
    await store.delete(expired);
    deleted += expired.length;
  }
  return { deleted };
}
