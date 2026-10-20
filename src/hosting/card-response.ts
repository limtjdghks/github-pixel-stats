import { renderStatusCard, type CardStatus } from "../render/status-card.js";
import { readPublishedCard, type CardStores } from "../storage/published-card.js";
import { parseCardRequest } from "./card-request.js";
import { jsonResponse, methodAllowed, methodNotAllowedResponse } from "./http.js";

/** 카드 응답의 cache 정책입니다. variant별 CDN cache와 canonical URL은 HOST-09에서 확정합니다. */
const PUBLISHED_CACHE_CONTROL = "public, max-age=300";
const STATUS_CACHE_CONTROL = "no-store";

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
      "Cache-Control": status === "ready" ? PUBLISHED_CACHE_CONTROL : STATUS_CACHE_CONTROL,
      "X-Card-Status": status,
    },
  });
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
  const { card, username } = parsed;
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
