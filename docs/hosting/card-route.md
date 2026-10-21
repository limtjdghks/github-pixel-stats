# HOST-07·09 카드 route

`/{username}/stats.svg`와 `/{username}/languages.svg`는 가입 없이 사용할 수 있는 카드 URL입니다. 카드 Function은 manifest가 가리키는 마지막 성공 카드를 public Blob에서 읽어 같은 URL로 응답합니다. 응답 경로는 어떤 저장소에도 쓰지 않으며, manifest가 없을 때만 background bootstrap이 checkpoint를 씁니다([`refresh.md`](./refresh.md)).

## 구성 요소

| 파일 | 책임 |
| --- | --- |
| `src/hosting/card-request.ts` | URL에서 카드 종류·사용자명·마스코트와 정규 경로 해석 |
| `src/storage/published-card.ts` | manifest 조회와 release별 카드 객체 선택·읽기 |
| `src/render/status-card.ts` | pending·상태 SVG 렌더링 |
| `src/hosting/card-response.ts` | 응답 상태·헤더 결정 |
| `api/card.ts` | 환경 설정과 Blob adapter 연결 |

## 요청 해석

- 공개 경로 `/{username}/{card}.svg`와 Vercel rewrite가 만든 `/api/card?__card={card}&__username={username}`을 모두 받습니다. rewrite query는 사용자가 붙인 `card`·`username` query와 겹치지 않도록 내부 이름(`ROUTING_PARAMS`)을 쓰며, `vercel.json`과 같은지 테스트로 확인합니다. Function이 받는 실제 URL 형태는 HOST-13 staging에서 확인합니다.
- 공개 경로이면 rewrite query는 카드 선택에 쓰지 않습니다. rewrite된 형태에서 같은 query가 서로 다른 값으로 여러 번 오면 어느 값도 고르지 않습니다. `__card`는 404, `__username`은 `invalid-username`, `mascot`은 기본 마스코트로 처리합니다.
- 사용자명은 `parseUsername()` 규칙으로 검사하고 대소문자를 구분하지 않습니다. 경로 값은 decode하지 않습니다.
- `stats.svg?mascot={id}`는 `resolveMascotId()`로 고릅니다. release에 그 variant가 없으면 기본 마스코트, 그것도 없으면 release의 첫 마스코트를 씁니다. registry 변경으로 release의 마스코트 목록이 비면 previous release 카드를 씁니다. `languages.svg`는 `mascot`을 무시합니다.
- `card` 값이 `stats`, `languages`가 아니면 404 JSON, GET·HEAD 외 method는 `Allow: GET, HEAD`와 함께 405 JSON입니다.

## 정규 URL

카드마다 정규 URL이 하나이며, 카드 본문의 CDN cache 항목은 마스코트 variant 단위로만 생깁니다. 규칙의 SSOT는 `canonicalCardPath()`입니다.

- 사용자명은 소문자입니다.
- `stats.svg`는 기본 마스코트이면 query가 없고, 등록된 다른 마스코트이면 `?mascot={id}` 하나만 둡니다. `languages.svg`는 query가 없습니다.
- 사용자명이 올바르지만 정규 URL이 아니면(대소문자 차이, 기본값·알 수 없는·빈 `mascot`, 그 외 query) 저장소를 읽지 않고 정규 경로로 `308` redirect합니다. `Location`은 상대 경로이며 HEAD도 같습니다.
- rewrite query(`__card`·`__username`)는 정규 값과 같으면 몇 번 와도 정규 URL로 봅니다. Function이 공개 경로·rewrite 형태·query가 합쳐진 형태 중 어느 URL을 받아도, 플랫폼이 rewrite query를 중복해 넘겨도 정규 URL을 다시 redirect하지 않습니다. 같은 값의 반복은 cache 항목을 늘리지만 redirect loop보다 안전한 쪽을 택했습니다.
- query는 decode한 이름·값으로 비교합니다. `?`·`&`만 다르거나 percent-encoding만 다른 URL은 같은 URL로 보고 redirect하지 않습니다. raw 문자열로 비교하면 rewrite가 query를 다시 encode할 때 정규 URL을 계속 redirect할 수 있기 때문입니다.
- 사용자가 붙인 `card`·`username` query는 그 외 query이므로 정규 URL로 redirect합니다. 다만 query가 합쳐진 형태에서 사용자가 `__username`·`__card`에 다른 값을 넣으면 rewrite 값과 충돌해 `invalid-username`·404가 됩니다.
- 사용자명 형식 오류와 알 수 없는 카드 종류는 redirect하지 않고 아래 응답을 따릅니다.

## 응답

README 이미지 proxy가 오류 응답을 그리지 않으므로 SVG 응답은 모두 200이며 `X-Card-Status`로 상태를 구분합니다.

| 상황 | `X-Card-Status` | 본문 | cache |
| --- | --- | --- | --- |
| current release 카드가 있음 | `ready` | 발행된 카드 | 발행 카드 |
| current 카드 객체가 없고 previous 카드가 있음 | `ready` | previous 카드 | 발행 카드 |
| manifest 없음(bootstrap 예약) | `pending` | pending SVG | `no-store` |
| 사용자명 형식 오류 | `invalid-username` | 상태 SVG | `no-store` |
| Blob store 미설정, manifest 손상, 카드 객체 없음, 읽기 실패·시간 초과 | `unavailable` | 상태 SVG | `no-store` |

## Cache

| 응답 | `Cache-Control` | `Vercel-CDN-Cache-Control` |
| --- | --- | --- |
| 발행 카드 | `public, max-age=300` | `max-age=3600, stale-while-revalidate=86400` |
| 정규 URL redirect | `public, max-age=300` | `max-age=86400` |
| 상태 SVG | `no-store` | 없음 |

- 갱신은 하루 1회라 purge 없이 TTL로만 운영합니다. 발행 후 이전 카드가 보일 수 있는 범위는 CDN fresh 1시간, 그 뒤 첫 요청의 stale 응답 1회(사본은 최대 25시간 전 것), 그리고 응답마다 그대로 전달되는 `Cache-Control`로 브라우저·이미지 proxy가 보관하는 5분입니다. 하루 한 번만 조회되는 경로는 매번 한 번 늦은 카드를 받을 수 있습니다. Vercel cache 시간은 best-effort라 드물게 요청되는 항목은 더 일찍 축출될 수 있습니다.
- 카드 본문 항목은 정규 URL당 하나지만, 비정규 URL은 URL마다 308 응답이 하루 동안 cache됩니다. 저장소는 읽지 않으며, 임의 query로 cache를 우회하는 요청의 방어는 HOST-10 범위입니다.
- Vercel CDN cache key에는 deployment URL이 들어가므로 배포마다 cache가 분리됩니다([Purging Vercel CDN cache](https://vercel.com/docs/caching/cdn-cache/purge)). 배포 직후에는 모든 카드 요청이 Function과 manifest 읽기로 가고, 이전 deployment로 rollback하면 그 deployment에 남은 cache 항목이 다시 쓰일 수 있습니다.
- 상태 SVG는 bootstrap 완료나 저장소 복구 직후 바로 바뀌어야 하므로 cache하지 않습니다. 반복 요청 방어는 HOST-10 negative cache 범위입니다.
- 카드 객체는 public store에 있어 원래 Blob CDN을 거쳐 읽습니다. SDK는 cache 우회(`useCache: false`)를 private store에만 적용하며, manifest는 private store라 계속 origin을 읽습니다. 카드 pathname은 내용 주소라 cache 사본도 같은 내용입니다.
- 실제 CDN의 header 적용과 `x-vercel-cache`, Blob 장애 중 SWR 재검증 응답이 상태 SVG일 때 이전 항목이 유지되는지는 HOST-13 staging에서 확인합니다.

- 상태 SVG는 요청한 카드와 같은 크기이며 사용자명 등 요청 입력값을 넣지 않습니다. 같은 상태·크기의 상태 SVG는 항상 같은 내용입니다.
- 모든 SVG 응답에 `Content-Type: image/svg+xml; charset=utf-8`, `X-Content-Type-Options: nosniff`와 inline style·data font만 허용하는 CSP를 붙입니다.
- 저장소 읽기 전체에 6초 예산(`CARD_READ_TIMEOUT_MS`)을 두어, Blob이 응답하지 않아도 `maxDuration`(10초)으로 504가 되기 전에 `unavailable`로 응답합니다.
- 읽기 실패는 오류 메시지만 Function 로그에 남깁니다.
- Blob store ID가 한쪽만 있거나 두 값이 같으면 Function이 시작 단계에서 실패해 모든 카드 요청이 500이 됩니다. 잘못된 설정을 상태 SVG로 가리지 않기 위한 의도된 fail-fast입니다.

## 범위 밖

manifest가 없는 사용자의 bootstrap은 [`refresh.md`](./refresh.md)에 있습니다. 신규 사용자 제한·negative cache·WAF는 HOST-10, cache hit율 등 운영 관측은 HOST-11입니다.
