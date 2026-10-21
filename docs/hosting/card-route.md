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

- 공개 경로 `/{username}/{card}.svg`와 Vercel rewrite가 만든 `/api/card?card={card}&username={username}`을 모두 받습니다. rewrite destination에 `username=:username`을 명시하며, Function이 받는 실제 URL 형태는 HOST-13 staging에서 확인합니다.
- 공개 경로이면 query의 `card`·`username`은 카드 선택에 쓰지 않습니다. rewrite된 형태에서 같은 query가 서로 다른 값으로 여러 번 오면 어느 값도 고르지 않습니다. `card`는 404, `username`은 `invalid-username`, `mascot`은 기본 마스코트로 처리합니다.
- 사용자명은 `parseUsername()` 규칙으로 검사하고 대소문자를 구분하지 않습니다. 경로 값은 decode하지 않습니다.
- `stats.svg?mascot={id}`는 `resolveMascotId()`로 고릅니다. release에 그 variant가 없으면 기본 마스코트, 그것도 없으면 release의 첫 마스코트를 씁니다. registry 변경으로 release의 마스코트 목록이 비면 previous release 카드를 씁니다. `languages.svg`는 `mascot`을 무시합니다.
- `card` 값이 `stats`, `languages`가 아니면 404 JSON, GET·HEAD 외 method는 `Allow: GET, HEAD`와 함께 405 JSON입니다.

## 정규 URL

카드마다 정규 URL이 하나이며 CDN cache key도 마스코트 variant 단위로만 나뉩니다. 규칙의 SSOT는 `canonicalCardPath()`입니다.

- 사용자명은 소문자입니다.
- `stats.svg`는 기본 마스코트이면 query가 없고, 등록된 다른 마스코트이면 `?mascot={id}` 하나만 둡니다. `languages.svg`는 query가 없습니다.
- 사용자명이 올바르지만 정규 URL이 아니면(대소문자 차이, 기본값·알 수 없는·빈 `mascot`, 그 외 query) 저장소를 읽지 않고 정규 경로로 `308` redirect합니다. `Location`은 상대 경로이며 HEAD도 같습니다.
- rewrite가 붙인 `card`·`username` query는 정규 값과 같은 한 번만 있으면 정규 URL로 봅니다. Function이 공개 경로·rewrite 형태 중 어느 URL을 받아도 정규 URL을 다시 redirect하지 않으며, 같은 query를 반복한 요청은 정규 URL로 보냅니다.
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

- 갱신은 하루 1회라 purge 없이 TTL로만 운영합니다. 발행 후 CDN에는 최대 1시간, 이후 요청이 없던 경로는 stale 응답 1회만큼 이전 카드가 남을 수 있습니다.
- 상태 SVG는 bootstrap 완료나 저장소 복구 직후 바로 바뀌어야 하므로 cache하지 않습니다. 반복 요청 방어는 HOST-10 negative cache 범위입니다.
- release 카드 객체는 내용 주소 pathname이라 Blob CDN cache를 거쳐 읽고(`ReadOptions.immutable`), manifest는 계속 cache를 우회합니다.
- 실제 CDN의 header 적용과 `x-vercel-cache`, 배포 시 CDN cache 무효화 여부는 HOST-13 staging에서 확인합니다.

- 상태 SVG는 요청한 카드와 같은 크기이며 사용자명 등 요청 입력값을 넣지 않습니다. 같은 상태·크기의 상태 SVG는 항상 같은 내용입니다.
- 모든 SVG 응답에 `Content-Type: image/svg+xml; charset=utf-8`, `X-Content-Type-Options: nosniff`와 inline style·data font만 허용하는 CSP를 붙입니다.
- 저장소 읽기 전체에 6초 예산(`CARD_READ_TIMEOUT_MS`)을 두어, Blob이 응답하지 않아도 `maxDuration`(10초)으로 504가 되기 전에 `unavailable`로 응답합니다.
- 읽기 실패는 오류 메시지만 Function 로그에 남깁니다.
- Blob store ID가 한쪽만 있거나 두 값이 같으면 Function이 시작 단계에서 실패해 모든 카드 요청이 500이 됩니다. 잘못된 설정을 상태 SVG로 가리지 않기 위한 의도된 fail-fast입니다.

## 범위 밖

manifest가 없는 사용자의 bootstrap은 [`refresh.md`](./refresh.md)에 있습니다. 신규 사용자 제한·negative cache·WAF는 HOST-10, cache hit율 등 운영 관측은 HOST-11입니다.
