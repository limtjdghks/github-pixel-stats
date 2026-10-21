import { DEFAULT_MASCOT_ID, resolveMascotId } from "../render/index.js";
import type { PublishedCard } from "../storage/published-card.js";
import { parseUsername } from "../username.js";

/**
 * 사용자명이 형식에 맞지 않거나 모호하면 `username`이 null입니다.
 * `canonicalPath`는 요청이 정규 카드 URL이 아닐 때만 있으며, 사용자명이 null이면 항상 없습니다.
 */
export interface CardRequest {
  card: PublishedCard;
  username: string | null;
  canonicalPath?: string;
}

const CARD_PATH = /^\/([^/]+)\/(stats|languages)\.svg$/;

/** rewrite destination이 붙이는 query입니다. 정규 URL 판정에서 rewrite 결과를 비정규로 오판하지 않도록 따로 다룹니다. */
const ROUTING_PARAMS = new Set(["card", "username"]);

function validUsername(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  try {
    return parseUsername(raw);
  } catch {
    return null;
  }
}

/**
 * query 값을 하나로 정합니다. 없거나 서로 다른 값이 여러 개면 null입니다.
 * rewrite가 destination query와 원래 요청 query를 합치는 순서에 기대지 않도록,
 * `?username=` 같은 사용자 입력이 rewrite 값과 충돌하면 어느 쪽도 고르지 않습니다.
 */
function singleParam(url: URL, name: string): string | null {
  const values = new Set(url.searchParams.getAll(name));
  return values.size === 1 ? [...values][0]! : null;
}

/**
 * 카드의 정규 경로입니다. 사용자명은 소문자이고, 기본 마스코트는 query를 생략하며 그 외 query는 없습니다.
 * 정규 경로는 마스코트 variant마다 하나라서 CDN cache key도 variant 단위로만 나뉩니다.
 */
export function canonicalCardPath(username: string, card: PublishedCard): string {
  const path = `/${parseUsername(username).toLowerCase()}/${card.kind}.svg`;
  return card.kind === "stats" && card.mascot !== DEFAULT_MASCOT_ID ? `${path}?mascot=${card.mascot}` : path;
}

/**
 * 요청이 정규 URL인지 판정합니다. 공개 경로든 rewrite 형태든 rewrite가 붙인 `card`·`username`은
 * 정규 값과 같은 한 번만 허용합니다. Function이 받는 URL 형태가 어느 쪽이어도 정규 URL을 다시 redirect하지 않고,
 * 같은 query를 반복해 cache key를 늘리는 요청은 정규 URL로 보냅니다.
 */
function isCanonical(url: URL, rawUsername: string, username: string, card: PublishedCard): boolean {
  if (rawUsername !== username.toLowerCase()) return false;
  const canonical = new URL(canonicalCardPath(username, card), url);
  const expected: Record<string, string> = { card: card.kind, username: rawUsername };
  const rest: [string, string][] = [];
  for (const name of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(name);
    if (!ROUTING_PARAMS.has(name)) {
      rest.push(...values.map((value): [string, string] => [name, value]));
    } else if (values.length !== 1 || values[0] !== expected[name]) {
      return false;
    }
  }
  return new URLSearchParams(rest).toString() === canonical.searchParams.toString();
}

/**
 * 카드 URL에서 카드 종류·사용자명·마스코트와 정규 경로를 해석합니다. 카드 종류를 알 수 없거나 모호하면 null입니다.
 * 공개 경로 `/{username}/{card}.svg`와 Vercel rewrite가 만든 `/api/card?card=...&username=...` 형태를 모두 받으며,
 * 공개 경로이면 query의 `card`·`username`은 카드 선택에 쓰지 않습니다. 실제 배포의 URL 형태는 HOST-13 staging에서 확인합니다.
 * 경로의 사용자명은 decode하지 않으므로 percent-encoding된 값은 잘못된 사용자명이 됩니다.
 */
export function parseCardRequest(url: URL): CardRequest | null {
  const match = CARD_PATH.exec(url.pathname);
  const kind = match ? match[2] : singleParam(url, "card");
  if (kind !== "stats" && kind !== "languages") return null;
  const rawUsername = match ? match[1]! : singleParam(url, "username");
  const username = validUsername(rawUsername);
  const card: PublishedCard = kind === "stats"
    ? { kind, mascot: resolveMascotId(singleParam(url, "mascot")) }
    : { kind };
  if (username === null || isCanonical(url, rawUsername!, username, card)) {
    return { card, username };
  }
  return { card, username, canonicalPath: canonicalCardPath(username, card) };
}
