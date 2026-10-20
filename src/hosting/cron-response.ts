import { createHash, timingSafeEqual } from "node:crypto";
import { runCron, type CronLimits } from "./cron-run.js";
import { jsonResponse } from "./http.js";
import type { RefreshDependencies } from "./refresh-job.js";

export interface CronConfig {
  secret: string | undefined;
  /** Blob store와 GitHub token이 모두 설정됐을 때만 있습니다. */
  dependencies: RefreshDependencies | undefined;
}

/** 길이가 달라도 비교 시간이 같도록 digest를 비교합니다. */
function authorized(request: Request, secret: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(request.headers.get("Authorization") ?? ""), digest(`Bearer ${secret}`));
}

/**
 * Vercel Cron 요청을 인증하고 갱신 루프를 실행합니다.
 * `CRON_SECRET`이나 갱신 의존성이 없으면 실행하지 않고 503으로 응답합니다(fail-closed).
 * 응답 본문에는 집계 수치만 담으며 사용자명이나 오류 메시지를 넣지 않습니다.
 * `limits`는 인증을 통과한 뒤 호출하므로 실행 시점의 deadline을 계산할 수 있습니다.
 */
export async function cronResponse(request: Request, config: CronConfig, limits: () => CronLimits): Promise<Response> {
  if (request.method !== "GET") {
    return jsonResponse(request, 405, { status: "method_not_allowed" }, { Allow: "GET" });
  }
  if (config.secret === undefined) {
    return jsonResponse(request, 503, { status: "not_configured" });
  }
  if (!authorized(request, config.secret)) {
    return jsonResponse(request, 401, { status: "unauthorized" });
  }
  if (config.dependencies === undefined) {
    return jsonResponse(request, 503, { status: "not_configured" });
  }
  try {
    const summary = await runCron(limits(), config.dependencies);
    return jsonResponse(request, 200, { status: "ok", ...summary });
  } catch (error) {
    console.error("Cron run failed:", error instanceof Error ? error.message : "unknown error");
    return jsonResponse(request, 500, { status: "error" });
  }
}
