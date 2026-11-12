import type { CollectorState, StatsSnapshot } from "../model.js";
import { parseState, type LoadedState } from "../data/state-validation.js";
import { parseManifest, type CardManifest, type CardRelease } from "./manifest.js";
import type { ObjectStore } from "./object-store.js";
import { manifestPathname, releasePathnames } from "./pathnames.js";

/** private store 객체는 CDN에 오래 남지 않도록 SDK가 허용하는 최소 TTL을 사용합니다. */
export const PRIVATE_CACHE_SECONDS = 60;
export const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

export interface StoredManifest {
  manifest: CardManifest;
  etag: string;
}

function assertPrivate(store: ObjectStore): void {
  if (store.access !== "private") {
    throw new Error("Hosted state requires a private store.");
  }
}

function parseJson(body: string, label: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

export async function readManifest(store: ObjectStore, username: string, signal?: AbortSignal): Promise<StoredManifest | null> {
  assertPrivate(store);
  const stored = await store.read(manifestPathname(username), signal);
  if (stored === null) return null;
  return { manifest: parseManifest(parseJson(stored.body, "Manifest"), username), etag: stored.etag };
}

/**
 * `expected`가 읽은 시점의 manifest와 같을 때만 교체합니다.
 * 다른 실행이 먼저 바꿨으면 false를 반환하므로 호출자는 manifest를 다시 읽어야 합니다.
 */
export async function replaceManifest(
  store: ObjectStore,
  manifest: CardManifest,
  expected: StoredManifest | null,
): Promise<boolean> {
  assertPrivate(store);
  const etag = await store.write(manifestPathname(manifest.username), `${JSON.stringify(manifest)}\n`, {
    contentType: JSON_CONTENT_TYPE,
    cacheControlMaxAge: PRIVATE_CACHE_SECONDS,
    condition: expected === null ? { kind: "absent" } : { kind: "match", etag: expected.etag },
  });
  return etag !== null;
}

/** release의 snapshot·state를 내용 주소 pathname에 저장합니다. */
export async function writeReleaseState(
  store: ObjectStore,
  release: CardRelease,
  snapshot: StatsSnapshot,
  state: CollectorState,
): Promise<void> {
  assertPrivate(store);
  const pathnames = releasePathnames(snapshot.username, release.version, release.mascots).private;
  const options = {
    contentType: JSON_CONTENT_TYPE,
    cacheControlMaxAge: PRIVATE_CACHE_SECONDS,
    condition: { kind: "content-addressed" },
  } as const;
  await Promise.all([
    store.write(pathnames.snapshot, `${JSON.stringify(snapshot)}\n`, options),
    store.write(pathnames.state, `${JSON.stringify(state)}\n`, options),
  ]);
}

/**
 * 마지막으로 발행된 release의 collector state를 수집 cache로 불러옵니다.
 * 발행 이력이 없으면 cache miss이며, manifest가 가리키는 state가 없거나 손상됐으면 오류입니다.
 */
export async function loadPublishedState(store: ObjectStore, username: string): Promise<LoadedState> {
  const stored = await readManifest(store, username);
  if (stored === null) {
    return { state: null, cacheUsable: false };
  }
  const { current } = stored.manifest;
  const pathname = releasePathnames(stored.manifest.username, current.version, current.mascots).private.state;
  const state = await store.read(pathname);
  if (state === null) {
    throw new Error("Published state is missing.");
  }
  return parseState(parseJson(state.body, "Published state"), username, "Published state");
}
