# Vercel 허용 API 기준선

- 확인일: 2026-09-12
- 기준 작업: GPS-HOST-00
- 적용 예정: GPS-HOST-05, GPS-HOST-06, GPS-HOST-08, GPS-HOST-09, GPS-HOST-10

## SDK 상태

현재 `@vercel/functions`와 `@vercel/blob`은 `package.json`과 `package-lock.json`에 설치되어 있지 않습니다. 2026-09-12 npm registry 조회 결과인 아래 버전은 후속 구현을 위한 참고 기준이며, 이번 작업에서 의존성으로 추가하지 않습니다.

| 패키지 | 참고 버전 | 실제 설치·타입 재확인 시점 |
| --- | ---: | --- |
| `@vercel/functions` | `3.9.7` | GPS-HOST-05 |
| `@vercel/blob` | `2.8.0` | GPS-HOST-06 |

후속 Issue를 시작할 때 공식 문서와 실제 설치 버전의 TypeScript 선언을 다시 확인합니다. 이 문서의 참고 버전만 보고 존재하지 않는 API나 옵션을 추정하지 않습니다.

재조회 명령:

```bash
npm view @vercel/functions version
npm view @vercel/blob version
```

## 허용 API와 사용 계약

| 기능 | 허용 API·설정 | 프로젝트 사용 계약 | 적용 Issue |
| --- | --- | --- | --- |
| Node Function | Web Standard `Request`를 받고 `Response`를 반환하는 handler | server-only 저장소에 Next.js를 추가하지 않고 공식 Web Handler 형태를 사용합니다. | GPS-HOST-05 |
| Background | `waitUntil(promise: Promise<unknown>): void`, `getDeadline(): Date \| undefined` | deadline보다 여유 있게 끝나는 짧고 bounded한 한 batch에만 사용합니다. | GPS-HOST-08 |
| Cron | `vercel.json`의 `crons[].path`, `crons[].schedule`, `CRON_SECRET` Bearer 인증 | UTC schedule을 사용하고 누락·중복·overlap에 안전한 idempotent endpoint로 구현합니다. | GPS-HOST-08 |
| Blob write | `put(pathname, body, options)` | immutable pathname을 우선하며, mutable manifest는 ETag와 `ifMatch`로 조건부 교체합니다. | GPS-HOST-06 |
| Blob read | `get(urlOrPathname, options)`, `head(urlOrPathname, options)`, `list(options)` | private state와 public card 저장소를 구분하고 `list({ prefix, cursor, limit })`를 pagination합니다. 반환 순서로 최신 항목을 추정하지 않습니다. | GPS-HOST-06 |
| Blob delete | `del(urlOrPathname, options)` 또는 `del(urlOrPathname[], options)` | 새 manifest 발행 이후 보존 기간이 지난 immutable object만 정리합니다. | GPS-HOST-06 |
| Blob 동시성 | `ifMatch`, `BlobPreconditionFailedError` | ETag 충돌을 성공으로 처리하지 않고 현재 manifest를 다시 읽어 조정합니다. | GPS-HOST-06 |
| CDN cache | `Cache-Control`, `CDN-Cache-Control`, `Vercel-CDN-Cache-Control`, `x-vercel-cache` | stable Function route와 immutable public Blob의 TTL을 분리하고 응답 헤더로 실제 cache 상태를 확인합니다. | GPS-HOST-09 |
| Secret | Production·Preview별 Secret 값, Secret 환경 변수 | GitHub token과 Blob 쓰기 권한은 Secret으로 저장하며 Preview에 운영 값을 기본 주입하지 않습니다. | GPS-HOST-05, GPS-HOST-13 |
| 요청 제한 | Vercel WAF rate-limit rule의 Log, 429, Deny action | 먼저 Log로 트래픽을 관측하고 근거가 확보된 뒤 경로별 429 또는 Deny를 적용합니다. | GPS-HOST-10 |

### Function과 background

[Functions API Reference](https://vercel.com/docs/functions/functions-api-reference)는 Function 입력을 Web Standard `Request`로 정의하고 `Response` 반환 예제를 제공합니다. plain Node.js Function은 다음과 같은 Web Handler 경계를 사용합니다.

```ts
export default {
  fetch(request: Request): Response | Promise<Response> {
    return new Response(request.url);
  },
};
```

[`@vercel/functions` API Reference](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package)에 따라 background helper의 기준 시그니처는 다음과 같습니다.

```ts
waitUntil(promise: Promise<unknown>): void;
getDeadline(): Date | undefined;
```

`waitUntil()`에 전달한 Promise는 Function과 같은 timeout을 적용받고, Function이 timeout되면 취소될 수 있습니다. `getDeadline()`은 요청 처리와 `waitUntil()` 작업이 공유하는 종료 시각을 반환하며 Vercel Functions runtime 밖에서는 `undefined`를 반환할 수 있습니다.

### Blob

[`@vercel/blob` SDK Reference](https://vercel.com/docs/vercel-blob/using-blob-sdk)를 기준으로 아래 시그니처만 사용합니다.

```ts
put(pathname, body, options);
get(urlOrPathname, options);
head(urlOrPathname, options);
list(options);
del(urlOrPathname, options);
del([urlOrPathname], options);
```

- store 생성 시 private 또는 public 접근 방식이 정해집니다. `put()`과 `get()` 등 access가 필요한 호출에는 실제 store와 일치하는 `access: 'private' | 'public'`을 명시합니다.
- `put()`에는 `access`가 필수이며 `contentType`, `cacheControlMaxAge`, `allowOverwrite`, `ifMatch` 등을 필요에 따라 사용합니다.
- `get()`은 private Blob 내용을 Function에서 전달할 때 사용하고, `head()`는 본문 없이 metadata와 ETag를 확인할 때 사용합니다.
- `list({ prefix, cursor, limit })`는 응답의 `hasMore`와 `cursor`를 따라 pagination합니다.
- `del()`은 단일 URL/pathname 또는 배열을 받습니다. 단일 대상에는 `ifMatch`를 사용할 수 있습니다.

[Blob conditional writes](https://vercel.com/docs/vercel-blob#conditional-writes)에 따라 mutable manifest 갱신에는 이전 `put()`, `get()` 또는 `head()`에서 얻은 ETag를 `ifMatch`로 전달합니다. 다른 실행이 먼저 Blob을 바꿔 ETag가 일치하지 않으면 `BlobPreconditionFailedError`가 발생하므로 현재 manifest를 재조회합니다. 이 계약은 private·public store 모두에 적용됩니다.

### Cron

[Managing Cron Jobs](https://vercel.com/docs/cron-jobs/manage-cron-jobs)에 따라 `vercel.json`에는 다음 형태만 사용합니다.

```json
{
  "crons": [
    {
      "path": "/api/cron",
      "schedule": "0 5 * * *"
    }
  ]
}
```

- schedule은 UTC 기준입니다.
- `CRON_SECRET`을 설정하면 Vercel이 `Authorization: Bearer <CRON_SECRET>` 헤더를 보내므로 endpoint에서 환경 변수 값과 검증합니다.
- 실패한 Cron invocation은 자동 재시도되지 않습니다.
- 전달은 best effort이며 실행이 누락되거나 같은 schedule이 두 번 전달될 수 있습니다. 이전 실행이 끝나기 전에 다음 실행이 시작될 수도 있으므로 lock과 idempotent reconciliation을 함께 사용합니다.

### Cache

[Cache-Control headers](https://vercel.com/docs/caching/cache-control-headers)에 따라 세 응답 헤더의 우선순위는 `Vercel-CDN-Cache-Control` > `CDN-Cache-Control` > `Cache-Control`입니다.

- `Cache-Control`은 브라우저와 공유 cache의 표준 동작을 지정합니다.
- `CDN-Cache-Control`은 Vercel을 포함한 CDN 동작을 지정합니다.
- `Vercel-CDN-Cache-Control`은 Vercel CDN에만 적용되며 응답이 클라이언트에 전달되기 전에 소비됩니다.
- [`x-vercel-cache`](https://vercel.com/docs/headers/response-headers#x-vercel-cache)는 Vercel CDN 상태를 나타냅니다. `HIT`, `MISS`, `STALE`, `PRERENDER`, `REVALIDATED`, `BYPASS`를 관측해 설정이 실제로 적용됐는지 확인합니다.

### Secret

[Sensitive environment variables](https://vercel.com/docs/environment-variables/sensitive-environment-variables)에 따라 비밀번호, API key, token은 읽기 가능한 Config가 아니라 저장 후 write-only인 Secret으로 분류합니다. Vercel은 환경별 또는 Preview branch별 다른 Secret 값을 지원하며, 이 프로젝트는 Production과 Preview 값을 분리합니다.

- Production GitHub token과 운영 Blob 쓰기 권한을 Preview에 기본 주입하지 않습니다.
- Secret을 응답, SVG, public Blob, 로그에 포함하지 않습니다.
- 필요한 팀에서는 `Require Separate Values` 정책을 활성화해 Production Secret 재사용을 막습니다.

### WAF rate limit

[WAF Rate Limiting](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting)에 따라 rate-limit rule은 요청 출처별 window와 limit을 설정하고 후속 action을 선택합니다. `Log`는 요청을 차단하지 않으므로 먼저 영향과 정상 트래픽을 관측하는 단계에 사용합니다. 관측 결과를 검토한 뒤 기본 `429` 또는 `Deny` action을 적용합니다.

## 금지 패턴

- `waitUntil()`을 Function timeout 이후에도 살아 있는 durable queue 또는 자동 재시도 수단으로 취급하지 않습니다.
- Cron을 exactly-once delivery로 가정하지 않고 redirect 경로를 Cron endpoint로 사용하지 않습니다.
- 동일 Blob pathname을 `allowOverwrite: true`만으로 갱신해 lost update를 숨기지 않습니다.
- private state, checkpoint, manifest 또는 token을 public Blob이나 공개 응답에 저장하지 않습니다.
- raw username이나 `mascot` query를 검증 없이 파일 경로, Blob pathname 또는 동적 import에 연결하지 않습니다.
- CDN cache miss에서 GitHub API 수집을 동기 실행하지 않습니다.
- 테스트에서 실제 GitHub API나 운영 Blob을 호출하지 않습니다.
- 호스팅 편의를 위해 현재 지표, activity 날짜 또는 언어 분모 계약을 조용히 변경하지 않습니다.
