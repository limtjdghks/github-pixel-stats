# HOST-07 카드 route

`/{username}/stats.svg`와 `/{username}/languages.svg`는 가입 없이 사용할 수 있는 카드 URL입니다. 카드 Function은 manifest가 가리키는 마지막 성공 카드를 public Blob에서 읽어 같은 URL로 응답합니다. 응답 경로는 어떤 저장소에도 쓰지 않으며, manifest가 없을 때만 background bootstrap이 checkpoint를 씁니다([`refresh.md`](./refresh.md)).

## 구성 요소

| 파일 | 책임 |
| --- | --- |
| `src/hosting/card-request.ts` | URL에서 카드 종류·사용자명·마스코트 해석 |
| `src/storage/published-card.ts` | manifest 조회와 release별 카드 객체 선택·읽기 |
| `src/render/status-card.ts` | pending·상태 SVG 렌더링 |
| `src/hosting/card-response.ts` | 응답 상태·헤더 결정 |
| `api/card.ts` | 환경 설정과 Blob adapter 연결 |

## 요청 해석

- 공개 경로 `/{username}/{card}.svg`와 Vercel rewrite가 만든 `/api/card?card={card}&username={username}`을 모두 받습니다. rewrite destination에 `username=:username`을 명시하며, Function이 받는 실제 URL 형태는 HOST-13 staging에서 확인합니다.
- 공개 경로이면 query의 `card`·`username`은 무시합니다. rewrite된 형태에서 같은 query가 서로 다른 값으로 여러 번 오면 어느 값도 고르지 않습니다. `card`는 404, `username`은 `invalid-username`, `mascot`은 기본 마스코트로 처리합니다.
- 사용자명은 `parseUsername()` 규칙으로 검사하고 대소문자를 구분하지 않습니다. 경로 값은 decode하지 않습니다.
- `stats.svg?mascot={id}`는 `resolveMascotId()`로 고릅니다. release에 그 variant가 없으면 기본 마스코트, 그것도 없으면 release의 첫 마스코트를 씁니다. registry 변경으로 release의 마스코트 목록이 비면 previous release 카드를 씁니다. `languages.svg`는 `mascot`을 무시합니다.
- `card` 값이 `stats`, `languages`가 아니면 404 JSON, GET·HEAD 외 method는 `Allow: GET, HEAD`와 함께 405 JSON입니다.

## 응답

README 이미지 proxy가 오류 응답을 그리지 않으므로 SVG 응답은 모두 200이며 `X-Card-Status`로 상태를 구분합니다.

| 상황 | `X-Card-Status` | 본문 | `Cache-Control` |
| --- | --- | --- | --- |
| current release 카드가 있음 | `ready` | 발행된 카드 | `public, max-age=300` |
| current 카드 객체가 없고 previous 카드가 있음 | `ready` | previous 카드 | `public, max-age=300` |
| manifest 없음(bootstrap 예약) | `pending` | pending SVG | `no-store` |
| 사용자명 형식 오류 | `invalid-username` | 상태 SVG | `no-store` |
| Blob store 미설정, manifest 손상, 카드 객체 없음, 읽기 실패·시간 초과 | `unavailable` | 상태 SVG | `no-store` |

- 상태 SVG는 요청한 카드와 같은 크기이며 사용자명 등 요청 입력값을 넣지 않습니다. 같은 상태·크기의 상태 SVG는 항상 같은 내용입니다.
- 모든 SVG 응답에 `Content-Type: image/svg+xml; charset=utf-8`, `X-Content-Type-Options: nosniff`와 inline style·data font만 허용하는 CSP를 붙입니다.
- 저장소 읽기 전체에 6초 예산(`CARD_READ_TIMEOUT_MS`)을 두어, Blob이 응답하지 않아도 `maxDuration`(10초)으로 504가 되기 전에 `unavailable`로 응답합니다.
- 읽기 실패는 오류 메시지만 Function 로그에 남깁니다.
- Blob store ID가 한쪽만 있거나 두 값이 같으면 Function이 시작 단계에서 실패해 모든 카드 요청이 500이 됩니다. 잘못된 설정을 상태 SVG로 가리지 않기 위한 의도된 fail-fast입니다.

## 범위 밖

manifest가 없는 사용자의 bootstrap은 [`refresh.md`](./refresh.md)에 있습니다. canonical URL redirect와 variant별 CDN cache 정책 확정은 HOST-09, 신규 사용자 제한·negative cache는 HOST-10입니다. 현재 Blob adapter는 모든 읽기에서 CDN cache를 거치지 않으므로, 불변 카드 객체의 cache 읽기도 HOST-09에서 다룹니다.
