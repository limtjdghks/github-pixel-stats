import { renderStatusCard, type CardStatus } from "../render/status-card.js";
import { readPublishedCard, type CardStores } from "../storage/published-card.js";
import { parseCardRequest } from "./card-request.js";
import { jsonResponse, methodAllowed, methodNotAllowedResponse } from "./http.js";

/**
 * 발행 카드의 cache 정책입니다. Vercel CDN은 1시간 동안 cache하고, 이후 하루 동안은 이전 사본을 한 번 응답하면서
 * background에서 다시 읽습니다. `Cache-Control`은 stale 응답에도 그대로 전달되므로 브라우저·이미지 proxy가 5분 더 보관합니다.
 * 하루 1회 갱신이라 purge 없이 TTL로만 운영합니다.
 */
const PUBLISHED_CACHE_HEADERS = {
  "Cache-Control": "public, max-age=300",
  "Vercel-CDN-Cache-Control": "max-age=3600, stale-while-revalidate=86400",
} as const;

/**
 * 정규 URL redirect의 cache 정책입니다. 대상은 요청 URL과 마스코트 registry로만 정해지므로 CDN에 하루 동안 둡니다.
 * Vercel CDN cache key에는 deployment URL이 들어가므로 registry가 바뀐 배포는 이전 redirect 항목을 쓰지 않습니다.
 */
const REDIRECT_CACHE_HEADERS = {
  "Cache-Control": "public, max-age=300",
  "Vercel-CDN-Cache-Control": "max-age=86400",
} as const;

/** 상태 SVG는 곧 바뀌거나 일시적인 상태이므로 어느 계층에서도 cache하지 않습니다. */
const STATUS_CACHE_HEADERS = { "Cache-Control": "no-store" } as const;

/**
 * 카드 읽기 전체 예산입니다. Function `maxDuration`(10초)에 걸려 504가 되기 전에 상태 SVG로 응답하도록
 * cold start와 응답 시간을 남겨 둡니다.
 */
export const CARD_READ_TIMEOUT_MS = 6_000;

/** SVG를 직접 열어도 스크립트·외부 리소스가 실행되지 않도록 inline style과 data font만 허용합니다. */
const SVG_HEADERS = {
  "Content-Type": "image/svg+xml; charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; font-src data:",
  "X-Content-Type-Options": "nosniff",
} as const;

/** 운영 관측용으로 응답의 상태를 `X-Card-Status`에 남깁니다. */
function svgResponse(request: Request, svg: string, status: CardStatus | "ready"): Response {
  return new Response(request.method === "HEAD" ? null : svg, {
    status: 200,
    headers: {
      ...SVG_HEADERS,
      ...(status === "ready" ? PUBLISHED_CACHE_HEADERS : STATUS_CACHE_HEADERS),
      "X-Card-Status": status,
    },
  });
}

/** 정규 카드 경로로 보냅니다. Function을 받는 host와 무관하도록 `Location`은 상대 경로입니다. */
function canonicalRedirect(path: string): Response {
  return new Response(null, { status: 308, headers: { ...REDIRECT_CACHE_HEADERS, Location: path } });
}

/**
 * signal이 중단되면 작업이 끝나지 않았어도 reject합니다.
 * OIDC token 조회처럼 signal을 받지 않는 단계가 있어 signal 전달만으로는 예산을 보장할 수 없기 때문입니다.
 */
function withinBudget<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export interface CardResponseOptions {
  /** 저장소 읽기 예산입니다. 기본값은 `CARD_READ_TIMEOUT_MS`입니다. */
  timeoutMs?: number;
  /**
   * manifest가 없어 `pending`으로 응답할 때만 응답 전에 한 번 호출합니다.
   * 응답을 늦추지 않도록 background 작업을 예약만 하고 바로 반환해야 하며, 던진 오류는 응답에 영향을 주지 않습니다.
   */
  onPending?: (username: string) => void;
}

/**
 * 카드 URL 요청에 마지막으로 발행된 카드 또는 상태 SVG로 응답합니다. 응답 경로는 저장소에 쓰지 않습니다.
 * README 이미지 proxy가 오류 응답을 그리지 않으므로 상태 SVG도 200으로 응답하고 상태는 헤더로 구분합니다.
 * 사용자명이 올바른 비정규 URL은 저장소를 읽지 않고 정규 경로로 308 redirect합니다.
 * `stores`가 없으면(Blob store 미설정) 형식이 올바른 카드 요청은 모두 `unavailable`입니다.
 * 저장소 읽기가 `timeoutMs` 안에 끝나지 않으면 `unavailable`로 응답합니다.
 */
export async function cardResponse(
  request: Request,
  stores: CardStores | undefined,
  { timeoutMs = CARD_READ_TIMEOUT_MS, onPending }: CardResponseOptions = {},
): Promise<Response> {
  if (!methodAllowed(request)) {
    return methodNotAllowedResponse(request);
  }
  const parsed = parseCardRequest(new URL(request.url));
  if (parsed === null) {
    return jsonResponse(request, 404, { status: "not_found" });
  }
  const { card, username, canonicalPath } = parsed;
  if (canonicalPath !== undefined) return canonicalRedirect(canonicalPath);
  const status = (value: CardStatus) => svgResponse(request, renderStatusCard(value, card.kind), value);
  if (username === null) return status("invalid-username");
  if (stores === undefined) return status("unavailable");
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const svg = await withinBudget(readPublishedCard(stores, username, card, signal), signal);
    if (svg !== null) return svgResponse(request, svg, "ready");
  } catch (error) {
    console.error("Card read failed:", error instanceof Error ? error.message : "unknown error");
    return status("unavailable");
  }
  try {
    onPending?.(username);
  } catch (error) {
    console.error("Pending hook failed:", error instanceof Error ? error.message : "unknown error");
  }
  return status("pending");
}
