import { createHash } from "node:crypto";
import type { CollectorState, StatsSnapshot } from "../model.js";
import type { MascotId } from "../render/index.js";
import { parseUsername } from "../username.js";

/**
 * hosted 저장소 pathname의 SSOT입니다.
 * private store: `checkpoints/`, `manifests/`, `releases/`
 * public store: `cards/`
 * raw username이나 query 값은 반드시 이 모듈을 거쳐 pathname이 됩니다.
 */

const RELEASE_VERSION = /^\d{8}-\d{6}-[0-9a-f]{16}$/;

function userKey(username: string): string {
  return parseUsername(username).toLowerCase();
}

function assertReleaseVersion(version: string): void {
  if (!RELEASE_VERSION.test(version)) {
    throw new Error("Invalid release version.");
  }
}

export function isReleaseVersion(value: unknown): value is string {
  return typeof value === "string" && RELEASE_VERSION.test(value);
}

/**
 * snapshot 생성 시각과 snapshot·state·렌더링된 카드 내용 hash로 release 버전을 만듭니다.
 * 같은 결과는 항상 같은 버전이 되므로 재시도한 발행이 같은 pathname에 같은 내용을 씁니다.
 * 카드 내용도 hash에 넣어, renderer가 바뀐 배포가 이미 참조 중인 카드 pathname을 다른 바이트로 덮지 않게 합니다.
 * `cards`의 key는 호출 간에 같은 순서·이름이어야 합니다.
 */
export function createReleaseVersion(snapshot: StatsSnapshot, state: CollectorState, cards: Readonly<Record<string, string>>): string {
  const generatedAt = new Date(snapshot.generatedAt).toISOString();
  const stamp = `${generatedAt.slice(0, 10).replaceAll("-", "")}-${generatedAt.slice(11, 19).replaceAll(":", "")}`;
  const hash = createHash("sha256").update(JSON.stringify({ snapshot, state, cards })).digest("hex").slice(0, 16);
  return `${stamp}-${hash}`;
}

export function checkpointPathname(username: string): string {
  return `checkpoints/${userKey(username)}.json`;
}

export function manifestPathname(username: string): string {
  return `manifests/${userKey(username)}.json`;
}

export function releasePrefix(username: string): string {
  return `releases/${userKey(username)}/`;
}

export function cardPrefix(username: string): string {
  return `cards/${userKey(username)}/`;
}

export interface ReleasePathnames {
  private: { snapshot: string; state: string };
  public: { languages: string; stats: Record<MascotId, string> };
}

export function releasePathnames(username: string, version: string, mascots: readonly MascotId[]): ReleasePathnames {
  assertReleaseVersion(version);
  const release = `${releasePrefix(username)}${version}/`;
  const cards = `${cardPrefix(username)}${version}/`;
  return {
    private: { snapshot: `${release}snapshot.json`, state: `${release}state.json` },
    public: {
      languages: `${cards}languages.svg`,
      stats: Object.fromEntries(mascots.map((id) => [id, `${cards}stats-${id}.svg`])) as Record<MascotId, string>,
    },
  };
}
