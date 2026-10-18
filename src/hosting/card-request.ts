import { resolveMascotId } from "../render/index.js";
import type { PublishedCard } from "../storage/published-card.js";
import { parseUsername } from "../username.js";

/** 사용자명이 형식에 맞지 않거나 모호하면 `username`이 null입니다. */
export interface CardRequest {
  card: PublishedCard;
  username: string | null;
}

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
 * `?username=` 같은 사용자 입력이 rewrite 값과 충돌하면 어느 쪽도 고르지 않습니다.
 */
function singleParam(url: URL, name: string): string | null {
  const values = new Set(url.searchParams.getAll(name));
  return values.size === 1 ? [...values][0]! : null;
}

/**
 * 카드 URL에서 카드 종류·사용자명·마스코트를 해석합니다. 카드 종류를 알 수 없거나 모호하면 null입니다.
 * 공개 경로 `/{username}/{card}.svg`와 Vercel rewrite가 만든 `/api/card?card=...&username=...` 형태를 모두 받으며,
 * 공개 경로이면 query의 `card`·`username`은 무시합니다. 실제 배포의 URL 형태는 HOST-13 staging에서 확인합니다.
 * 경로의 사용자명은 decode하지 않으므로 percent-encoding된 값은 잘못된 사용자명이 됩니다.
 */
export function parseCardRequest(url: URL): CardRequest | null {
  const match = CARD_PATH.exec(url.pathname);
  const kind = match ? match[2] : singleParam(url, "card");
  if (kind !== "stats" && kind !== "languages") return null;
  const username = validUsername(match ? match[1] : singleParam(url, "username"));
  const card: PublishedCard = kind === "stats"
    ? { kind, mascot: resolveMascotId(singleParam(url, "mascot")) }
    : { kind };
  return { card, username };
}
