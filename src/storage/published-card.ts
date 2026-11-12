import { DEFAULT_MASCOT_ID, type MascotId } from "../render/index.js";
import type { CardRelease } from "./manifest.js";
import type { ObjectStore } from "./object-store.js";
import { releasePathnames } from "./pathnames.js";
import { readManifest } from "./private-repository.js";

export type PublishedCard = { kind: "stats"; mascot: MascotId } | { kind: "languages" };

export interface CardStores {
  privateStore: ObjectStore;
  publicStore: ObjectStore;
}

/**
 * release에서 제공할 stats 카드의 마스코트를 고릅니다.
 * 요청한 마스코트 → 기본 마스코트 → release의 첫 마스코트 순이며, 기본 마스코트가 바뀐 배포 직후의
 * 오래된 release도 카드를 제공할 수 있게 합니다. 목록이 비어 있으면 undefined입니다.
 */
export function selectReleaseMascot(release: CardRelease, requested: MascotId): MascotId | undefined {
  if (release.mascots.includes(requested)) return requested;
  if (release.mascots.includes(DEFAULT_MASCOT_ID)) return DEFAULT_MASCOT_ID;
  return release.mascots[0];
}

function cardPathname(username: string, release: CardRelease, card: PublishedCard): string | undefined {
  if (card.kind === "languages") {
    return releasePathnames(username, release.version, []).public.languages;
  }
  const mascot = selectReleaseMascot(release, card.mascot);
  return mascot === undefined ? undefined : releasePathnames(username, release.version, [mascot]).public.stats[mascot];
}

/**
 * manifest가 가리키는 마지막 성공 카드 SVG를 읽습니다. 어떤 저장소에도 쓰지 않습니다.
 * 발행 이력이 없으면 null을 반환합니다. current 카드 객체가 없거나 고를 마스코트가 없으면 previous release 카드로 대체하고,
 * 둘 다 없거나 manifest·저장소를 읽을 수 없으면 오류를 던집니다. `signal`은 모든 저장소 읽기에 전달합니다.
 */
export async function readPublishedCard(
  stores: CardStores,
  username: string,
  card: PublishedCard,
  signal?: AbortSignal,
): Promise<string | null> {
  if (stores.privateStore.access !== "private" || stores.publicStore.access !== "public") {
    throw new Error("Card stores have unexpected access.");
  }
  const stored = await readManifest(stores.privateStore, username, signal);
  if (stored === null) return null;
  const { manifest } = stored;
  for (const release of [manifest.current, manifest.previous]) {
    if (release === null) continue;
    const pathname = cardPathname(manifest.username, release, card);
    if (pathname === undefined) continue;
    const object = await stores.publicStore.read(pathname, signal);
    if (object !== null) return object.body;
  }
  throw new Error("Published card is missing.");
}
