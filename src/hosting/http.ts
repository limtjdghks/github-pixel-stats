export function jsonResponse(
  request: Request,
  status: number,
  body: Readonly<Record<string, unknown>>,
  headers: Record<string, string> = {},
): Response {
  return new Response(request.method === "HEAD" ? null : JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

export function methodAllowed(request: Request): boolean {
  return request.method === "GET" || request.method === "HEAD";
}

export function methodNotAllowedResponse(request: Request): Response {
  return jsonResponse(request, 405, { status: "method_not_allowed" }, { Allow: "GET, HEAD" });
}

/** 외부 의존성 조회 없이 Function 기동 상태만 반환합니다. */
export function healthResponse(request: Request): Response {
  if (!methodAllowed(request)) {
    return methodNotAllowedResponse(request);
  }
  return jsonResponse(request, 200, { status: "ok" });
}
