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

/**
 * `vercel.json` rewrite destination이 붙이는 query 이름입니다. 사용자가 붙인 `card`·`username` query와 겹치지 않도록
 * 내부 이름을 쓰며, 바꾸면 `vercel.json`도 함께 바꿔야 합니다.
 */
export const ROUTING_PARAMS = { card: "__card", username: "__username" } as const;

const CARD_PATH = /^\/([^/]+)\/(stats|languages)\.svg$/;

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
 * 사용자 입력이 rewrite 값과 충돌하면 어느 쪽도 고르지 않습니다.
 */
function singleParam(url: URL, name: string): string | null {
  const values = new Set(url.searchParams.getAll(name));
  return values.size === 1 ? [...values][0]! : null;
}

function canonicalUsername(username: string): string {
  return parseUsername(username).toLowerCase();
}

/**
 * 카드의 정규 경로입니다. 사용자명은 소문자이고, 기본 마스코트는 query를 생략하며 그 외 query는 없습니다.
 * 카드 본문의 CDN cache key가 마스코트 variant마다 하나가 되게 합니다.
 */
export function canonicalCardPath(username: string, card: PublishedCard): string {
  const path = `/${canonicalUsername(username)}/${card.kind}.svg`;
  return card.kind === "stats" && card.mascot !== DEFAULT_MASCOT_ID ? `${path}?mascot=${card.mascot}` : path;
}

/**
 * 요청이 정규 URL인지 판정합니다. query는 decode한 이름·값으로 비교하므로 `?`·`&`만 다르거나
 * percent-encoding만 다른 URL은 같은 URL로 봅니다. raw 문자열로 비교하면 rewrite가 query를 다시 encode할 때
 * 정규 URL을 계속 redirect할 수 있기 때문입니다.
 * rewrite가 붙인 query는 정규 값과 같기만 하면 몇 번 와도 허용해, Function이 받는 URL 형태가 어느 쪽이어도
 * 정규 URL을 다시 redirect하지 않습니다.
 */
function isCanonical(url: URL, rawUsername: string, username: string, card: PublishedCard): boolean {
  if (rawUsername !== canonicalUsername(username)) return false;
  const routing = new Map<string, string>([[ROUTING_PARAMS.card, card.kind], [ROUTING_PARAMS.username, rawUsername]]);
  const rest: [string, string][] = [];
  for (const [name, value] of url.searchParams) {
    const expected = routing.get(name);
    if (expected === undefined) {
      rest.push([name, value]);
    } else if (value !== expected) {
      return false;
    }
  }
  const canonical = new URL(canonicalCardPath(username, card), url);
  return new URLSearchParams(rest).toString() === canonical.searchParams.toString();
}

/**
 * 카드 URL에서 카드 종류·사용자명·마스코트와 정규 경로를 해석합니다. 카드 종류를 알 수 없거나 모호하면 null입니다.
 * 공개 경로 `/{username}/{card}.svg`와 Vercel rewrite가 만든 `/api/card?__card=...&__username=...` 형태를 모두 받으며,
 * 공개 경로이면 rewrite query는 카드 선택에 쓰지 않습니다. 실제 배포의 URL 형태는 HOST-13 staging에서 확인합니다.
 * 경로의 사용자명은 decode하지 않으므로 percent-encoding된 값은 잘못된 사용자명이 됩니다.
 */
export function parseCardRequest(url: URL): CardRequest | null {
  const match = CARD_PATH.exec(url.pathname);
  const kind = match ? match[2] : singleParam(url, ROUTING_PARAMS.card);
  if (kind !== "stats" && kind !== "languages") return null;
  const rawUsername = match ? match[1]! : singleParam(url, ROUTING_PARAMS.username);
  const card: PublishedCard = kind === "stats"
    ? { kind, mascot: resolveMascotId(singleParam(url, "mascot")) }
    : { kind };
  const username = validUsername(rawUsername);
  if (rawUsername === null || username === null) return { card, username: null };
  return isCanonical(url, rawUsername, username, card)
    ? { card, username }
    : { card, username, canonicalPath: canonicalCardPath(username, card) };
}
