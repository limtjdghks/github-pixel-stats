import type { LinguistClassifier } from "../data/linguist.js";
import type { CollectionResult } from "../model.js";
import {
  getMascotRenderer,
  MASCOT_IDS,
  renderLanguagesCard,
  renderPreviewHtml,
  renderStatsCard,
  type MascotId,
} from "../render/index.js";
import { validateGeneratedOutput } from "../validation/output.js";
import { removeUnreferencedReleases, type CleanupReport } from "./cleanup.js";
import { MANIFEST_SCHEMA_VERSION, type CardManifest, type CardRelease } from "./manifest.js";
import type { ObjectStore } from "./object-store.js";
import { createReleaseVersion, releasePathnames } from "./pathnames.js";
import { readManifest, replaceManifest, writeReleaseState } from "./private-repository.js";

/** 카드 pathname은 내용 hash를 포함해 바뀌지 않으므로 CDN·브라우저에 길게 둡니다. */
const PUBLIC_CARD_CACHE_SECONDS = 365 * 24 * 60 * 60;
const MAX_MANIFEST_ATTEMPTS = 3;

export interface PublishDependencies {
  privateStore: ObjectStore;
  publicStore: ObjectStore;
  classifier: LinguistClassifier;
  now(): Date;
}

/**
 * - `published`: manifest를 새 release로 교체했습니다. 정리 실패는 발행 성공을 바꾸지 않고 `cleanup`에 기록합니다.
 * - `unchanged`: 같은 release가 이미 현재 버전입니다.
 * - `stale`: 같거나 더 새로운 snapshot이 이미 발행되어 manifest를 바꾸지 않았습니다.
 * - `conflict`: 재시도 한도 안에 manifest 경합을 해소하지 못했습니다. 마지막 성공 카드는 그대로입니다.
 */
export type PublishOutcome =
  | { status: "published"; manifest: CardManifest; cleanup: CleanupReport | { error: string } }
  | { status: "unchanged" | "stale"; manifest: CardManifest }
  | { status: "conflict" };

interface RenderedRelease {
  release: CardRelease;
  languagesSvg: string;
  statsSvgs: Record<MascotId, string>;
}

function renderRelease(result: CollectionResult, classifier: LinguistClassifier): RenderedRelease {
  const { snapshot, nextState } = result;
  const languagesSvg = renderLanguagesCard(snapshot);
  const statsSvgs = {} as Record<MascotId, string>;
  for (const id of MASCOT_IDS) {
    const statsSvg = renderStatsCard(snapshot, getMascotRenderer(id));
    validateGeneratedOutput({
      expectedUsername: nextState.username,
      snapshot,
      state: nextState,
      statsSvg,
      languagesSvg,
      preview: renderPreviewHtml(statsSvg, languagesSvg),
      classifier,
    });
    statsSvgs[id] = statsSvg;
  }
  return {
    release: {
      version: createReleaseVersion(snapshot, nextState),
      generatedAt: snapshot.generatedAt,
      mascots: [...MASCOT_IDS],
    },
    languagesSvg,
    statsSvgs,
  };
}

async function writeCards(store: ObjectStore, username: string, rendered: RenderedRelease): Promise<void> {
  const pathnames = releasePathnames(username, rendered.release.version, rendered.release.mascots).public;
  const cards: Array<[string, string]> = [
    [pathnames.languages, rendered.languagesSvg],
    ...rendered.release.mascots.map((id): [string, string] => [pathnames.stats[id], rendered.statsSvgs[id]]),
  ];
  await Promise.all(cards.map(([pathname, svg]) => store.write(pathname, svg, {
    contentType: "image/svg+xml; charset=utf-8",
    cacheControlMaxAge: PUBLIC_CARD_CACHE_SECONDS,
    condition: { kind: "content-addressed" },
  })));
}

/**
 * 수집 결과를 검증된 카드로 발행합니다.
 * 순서: SVG 생성·검증 → private snapshot·state 저장 → public 카드 저장 → manifest 조건부 교체 → 오래된 release 정리.
 * manifest 교체 전에 실패하면 예외를 던지며, 마지막 성공 manifest와 카드는 바뀌지 않습니다.
 */
export async function publishRelease(result: CollectionResult, dependencies: PublishDependencies): Promise<PublishOutcome> {
  const { privateStore, publicStore } = dependencies;
  if (privateStore.access !== "private" || publicStore.access !== "public") {
    throw new Error("Publishing requires a private state store and a public card store.");
  }
  // 저장 전에 검증해 실패한 결과가 저장소에 남지 않게 합니다.
  const rendered = renderRelease(result, dependencies.classifier);
  const { snapshot, nextState } = result;
  await writeReleaseState(privateStore, rendered.release, snapshot, nextState);
  await writeCards(publicStore, snapshot.username, rendered);

  for (let attempt = 0; attempt < MAX_MANIFEST_ATTEMPTS; attempt += 1) {
    const stored = await readManifest(privateStore, snapshot.username);
    if (stored !== null) {
      const { current } = stored.manifest;
      if (current.version === rendered.release.version) {
        return { status: "unchanged", manifest: stored.manifest };
      }
      if (Date.parse(current.generatedAt) >= Date.parse(rendered.release.generatedAt)) {
        return { status: "stale", manifest: stored.manifest };
      }
    }
    const manifest: CardManifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      username: snapshot.username,
      publishedAt: dependencies.now().toISOString(),
      current: rendered.release,
      previous: stored?.manifest.current ?? null,
    };
    if (await replaceManifest(privateStore, manifest, stored)) {
      let cleanup: CleanupReport | { error: string };
      try {
        cleanup = await removeUnreferencedReleases({ private: privateStore, public: publicStore }, manifest, dependencies.now());
      } catch (error) {
        cleanup = { error: error instanceof Error ? error.message : String(error) };
      }
      return { status: "published", manifest, cleanup };
    }
  }
  return { status: "conflict" };
}
