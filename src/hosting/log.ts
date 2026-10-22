type LogValue = string | number | boolean | null | Readonly<Record<string, number>>;

/**
 * Function 로그를 한 줄 JSON 이벤트로 남깁니다. Vercel 런타임 로그에서 `event`로 걸러 볼 수 있습니다.
 * 필드에는 집계 수치와 상태만 넣고 사용자명·Secret은 넣지 않습니다.
 */
export function logEvent(event: string, fields: Readonly<Record<string, LogValue>> = {}): void {
  console.log(JSON.stringify({ level: "info", event, ...fields }));
}

/** 오류는 메시지만 남깁니다. 메시지가 없는 값은 `unknown error`로 남깁니다. */
export function logError(event: string, error: unknown): void {
  console.error(JSON.stringify({ level: "error", event, error: error instanceof Error ? error.message : "unknown error" }));
}
