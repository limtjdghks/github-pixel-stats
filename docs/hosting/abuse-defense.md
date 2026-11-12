# HOST-10 익명 요청 방어

카드 URL은 가입 없이 쓸 수 있으므로, 사용자명만 바꾼 요청으로 신규 사용자가 무제한으로 생기거나 존재하지 않는 사용자의 요청이 GitHub API·Function·Blob 사용량을 키울 수 있습니다. 아래 세 계층으로 막습니다.

| 계층 | 막는 것 | 위치 |
| --- | --- | --- |
| 등록 상한 | 신규 사용자 수, 실패 표시가 없는 등록 사용자 수 | 앱(등록 기록) |
| negative cache | 실패한 사용자·형식 오류·상한 도달 응답의 반복 비용 | 앱(등록 기록)과 Vercel CDN |
| WAF rate limit | 한 출처의 대량 요청, 임의 query로 cache를 우회하는 요청 | Vercel Firewall |

## 구성 요소

| 파일 | 책임 |
| --- | --- |
| `src/hosting/admission-policy.ts` | 상한 값, 등록 상태 판정과 등록·실패 표시·해제 규칙(SSOT) |
| `src/storage/admissions.ts` | 등록 기록 형식·검증과 ETag 조건부 갱신 |
| `src/hosting/bootstrap.ts` | 수집 전 등록, 실패 시 표시 |
| `src/hosting/card-response.ts` | 발행 전 사용자의 상태 SVG와 상태별 cache |
| `src/hosting/refresh-policy.ts` | 실패 표시된 미발행 사용자를 Cron 순서의 맨 뒤로 보냄 |
| `src/hosting/cron-run.ts` | 실행 결과의 실패 표시·해제 |

## 등록 기록

private store의 `admissions.json` 하나에 전체 사용자를 기록합니다. 사용자 key(소문자)마다 등록 시각 `admittedAt`, 실패 표시 `failedAt`, 운영자 삭제 표시 `removedAt`(없으면 null)을 둡니다. 상한을 동시 요청에서도 정확히 지키기 위해 사용자별 객체가 아닌 단일 객체를 쓰고, 항상 읽은 ETag로만 조건부 교체합니다. 충돌하면 다시 읽어 판정을 다시 하며, 5번 모두 충돌하면 이번 bootstrap을 포기합니다. 포기한 사용자는 등록되지 않았으므로 다음 카드 요청이 다시 시도합니다. 등록 기록 읽기·쓰기는 bootstrap에서는 bootstrap deadline, Cron에서는 한 번에 4초(`CRON_ADMISSIONS_TIMEOUT_MS`) 안에서만 실행합니다.

등록 상태는 다음 중 하나입니다(`admissionDecision()`).

| 상태 | 조건 | 카드 응답 |
| --- | --- | --- |
| `admitted` | 등록됨, 실패 표시 없음 | `pending`, bootstrap 예약 |
| `failed` | 등록됨, 실패 표시 있음 | `failed` |
| `open` | 등록 안 됨, 상한에 여유 | `pending`, bootstrap 예약 |
| `capacity` | 등록 안 됨, 상한 도달 | `capacity` |
| `removed` | 삭제 표시 있음 | `removed`([`recovery.md`](./recovery.md)) |

## 상한

| 상한 | 값 | 세는 대상 |
| --- | ---: | --- |
| 신규 등록(`NEW_USER_LIMIT`) | 5명 | `admittedAt`이 최근 24시간 안인 사용자. 실패 표시된 사용자 포함 |
| active(`ACTIVE_USER_LIMIT`) | 20명 | 실패 표시가 없는 사용자 |

- 신규 등록 기간은 UTC 날짜가 아니라 등록 시각 기준 최근 24시간입니다.
- 신규 등록에 실패한 사용자도 세므로, 존재하지 않는 사용자명으로 GitHub를 호출하는 bootstrap은 24시간마다 5명까지만 생깁니다.
- active에는 실패한 사용자를 세지 않아, 존재하지 않는 사용자명이 자리를 영구히 차지하지 않습니다. 대신 실패 후 Cron으로 회복한 사용자만큼 active가 일시적으로 20명을 넘을 수 있습니다.
- active 상한은 Cron 작업량의 상한이 아닙니다. 실패 표시된 미발행 사용자도 checkpoint가 남아 있어 Cron이 매일 다시 수집합니다. 실패 표시 후 7일이 지나면 Cron이 checkpoint와 등록 항목을 지우므로, 이런 사용자는 많아야 약 7~8일치(최대 40명 안팎)만 남습니다. 정리는 하루 1회 Cron 때만 일어나 7일이 찬 뒤 다음 Cron까지 하루 가까이 더 남을 수 있기 때문입니다([`recovery.md`](./recovery.md)). 이들은 Cron 순서에서 발행 사용자와 다른 미발행 사용자 뒤에 두므로 예산이 모자라면 먼저 밀려납니다.
- 이미 등록된 사용자와 발행된 사용자는 상한과 관계없이 bootstrap·Cron 갱신·카드 응답을 받습니다. 발행된 사용자는 manifest를 먼저 읽으므로 등록 기록을 읽지 않습니다.
- 값은 epic의 초기 권장값이며 정책 모듈 상수로만 바꿉니다.
- 운영자가 삭제 표시한 사용자(`removed`)는 두 상한 어느 쪽에도 세지 않습니다([`recovery.md`](./recovery.md)).

## 흐름

1. 카드 요청은 manifest가 없을 때만 같은 읽기 예산(6초) 안에서 등록 기록을 읽고 위 표대로 응답합니다. 응답 경로는 계속 저장소에 쓰지 않으며, 등록 기록이 손상됐거나 읽지 못하면 `unavailable`입니다.
2. bootstrap은 수집 전에 등록 기록을 조건부로 교체해 등록합니다. 카드 요청이 읽은 뒤 다른 요청이 마지막 자리를 가져갔으면 GitHub 요청 없이 끝나고, 다음 카드 요청은 `capacity`를 받습니다.
3. bootstrap의 수집이 `failed`이면 실패를 표시합니다. 이후 카드 요청은 bootstrap을 예약하지 않고 `failed`를 받습니다. 표시가 빠졌으면(예: deadline) 다음 카드 요청의 bootstrap이 GitHub 요청 없이 `failed`를 확인해 다시 표시합니다.
4. Cron은 시작할 때 등록 기록을 읽어 실패 표시된 미발행 사용자를 맨 뒤에 두고, 실패 표시와 무관하게 다시 수집합니다([`refresh.md`](./refresh.md)).
5. Cron은 실행이 끝날 때 한 번의 쓰기로 등록 기록을 정리합니다. manifest가 있거나 이번에 발행한 사용자의 실패 표시를 지우고, 이번에 발행 없이 `failed`가 된 등록 사용자에 실패를 표시합니다. 시작 때의 manifest 목록으로도 지우므로, 발행 직후 오류로 이번 결과에 빠진 사용자의 표시도 다음 실행에서 지워집니다. 시작 때 읽은 기록으로 바꿀 것이 없으면 쓰지 않습니다.
6. 등록 기록 읽기·쓰기가 실패해도 Cron의 갱신과 발행은 계속되며, 실패는 Cron 응답의 `errors`에 집계됩니다. 카드 요청은 manifest를 먼저 읽으므로 표시가 남아 있어도 발행 카드를 받습니다.

## Negative cache

상태 SVG는 모두 200이며 `X-Card-Status`로 구분합니다. Vercel CDN cache key에는 deployment URL이 들어가므로 배포마다 cache가 분리됩니다.

| `X-Card-Status` | `Cache-Control` | `Vercel-CDN-Cache-Control` | 이유 |
| --- | --- | --- | --- |
| `invalid-username` | `public, max-age=300` | `max-age=86400` | URL과 배포된 사용자명 규칙만으로 정해짐 |
| `failed` | `no-store` | `max-age=3600` | Cron 회복 후 최대 1시간 늦게 카드가 보임 |
| `capacity` | `no-store` | `max-age=600` | 자리가 생긴 뒤 최대 10분 늦게 bootstrap이 예약됨 |
| `removed` | `no-store` | `max-age=3600` | 운영자가 해제하기 전까지 바뀌지 않음. 해제 뒤 최대 1시간 늦게 반영 |
| `pending`, `unavailable` | `no-store` | 없음 | bootstrap 완료나 저장소 복구 직후 바로 바뀌어야 함 |

- `failed`·`capacity`는 회복 뒤 바로 바뀌도록 브라우저·이미지 proxy에는 cache하지 않고 Vercel CDN에만 둡니다. [Cache-Control headers](https://vercel.com/docs/caching/cache-control-headers) 문서상 `Vercel-CDN-Cache-Control`이 `Cache-Control`보다 우선하므로 반복 요청은 CDN에서 끝나야 하며, 실제 동작은 HOST-13에서 확인합니다.
- 발행된 사용자의 카드 URL은 manifest를 먼저 읽어 `ready`가 되므로, 발행 카드의 CDN 항목이 `failed`·`capacity`로 바뀌지 않습니다. `unavailable`은 cache하지 않아 저장소 장애가 발행 카드 항목을 덮지 않게 합니다.
- `pending`은 cache하지 않으므로 등록된 미발행 사용자의 반복 요청은 매번 Function과 manifest·등록 기록 읽기에 닿습니다. bootstrap은 checkpoint lease로 사용자당 한 실행만 수집합니다.

## WAF rate limit

앱 계층은 사용자 수와 GitHub 요청을 막지만, 서로 다른 사용자명이나 임의 query로 cache를 우회하는 대량 요청의 Function·CDN 사용량은 막지 못합니다. 비정규 URL은 저장소를 읽지 않는 308이고 상한에 도달한 뒤의 미등록 사용자명은 private store 읽기 두 번(manifest·등록 기록)으로 끝나지만, 요청 수 자체는 Vercel Firewall이 막습니다.

[WAF Rate Limiting](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting)(2026-10-21 확인)에 따르면 Hobby는 프로젝트당 rate-limit rule 1개, fixed window 10초~10분, counting key는 IP와 JA4 digest이며 action은 기본 429, Log, Deny, Challenge입니다. rule은 dashboard에서 만들고 production deployment에 publish합니다. 아래는 초기 설정안이며 실제 생성과 값 조정은 HOST-13에서 합니다.

| 항목 | 초기 설정안 |
| --- | --- |
| 조건 | 요청 path가 `.svg`로 끝나거나 `/api/card`로 시작 |
| key | IP |
| window·limit | 60초·300회 |
| action | Log로 시작해 관측 후 429 |

- GitHub README 이미지는 GitHub 이미지 proxy를 거치므로 많은 viewer의 요청이 적은 수의 IP로 모일 수 있고, `no-store` 상태 SVG는 조회마다 요청될 수 있습니다. IP 기준 limit이 정상 README 트래픽을 막지 않는지 Log로 먼저 확인한 뒤 action을 바꿉니다.
- Cron(`/api/cron`)과 health check(`/healthz`)는 조건에 해당하지 않아 rate limit을 받지 않습니다.
- counter는 region별이라 여러 region에서 온 요청은 설정한 limit을 넘을 수 있습니다.

## 등록 기록 손상

등록 기록은 fail-closed입니다. 형식이 맞지 않으면 자동으로 고치지 않고, 발행되지 않은 사용자의 카드 요청은 모두 `unavailable`, bootstrap은 수집 없이 끝나며 Cron은 등록 기록 오류를 집계한 채 갱신만 계속합니다. 발행된 사용자의 카드는 영향을 받지 않습니다.

복구는 운영자가 private store의 `admissions.json`을 직접 고치거나 지웁니다. 지우면 모든 등록과 실패 표시가 사라져, 미발행 사용자는 다시 상한 안에서 등록되고 신규 등록 기간도 처음부터 셉니다. 발행된 사용자는 manifest로 계속 제공되지만 bootstrap을 거치지 않아 등록 기록에 다시 생기지 않으므로 active 수에서 빠집니다. 그래서 지우기보다 손상된 항목만 고치는 편이 낫습니다.

파일을 지우면 운영자 삭제 표시(`removedAt`)도 사라집니다. 그러면 삭제를 요청한 사용자의 카드 URL이 다시 요청될 때 등록·수집이 다시 시작되는데, `PRIVACY.md`는 삭제된 사용자명을 다시 수집하지 않는다고 약속합니다. 손상된 파일은 CLI `status`로 읽을 수 없으므로 다음 순서로 처리합니다.

1. 지우기 전에 dashboard에서 손상된 `admissions.json` 원문을 내려받아 `removedAt`이 있는 사용자명을 확인합니다. 원문에서 찾을 수 없으면 보관 중인 삭제 요청 메일로 확인합니다. 메일은 완료 후 30일 안에 지우므로 그보다 오래된 요청은 이 방법으로 찾을 수 없습니다.
2. 파일을 지운 직후 사용자마다 운영자 CLI의 `delete <user> --yes`([`recovery.md`](./recovery.md#운영자-cli))로 다시 표시합니다. 등록된 적이 없는 사용자도 표시되며, 이미 지워진 객체는 다시 지울 것이 없습니다.
3. 파일을 지운 시점과 다시 표시한 시점 사이에 그 URL이 요청되면 bootstrap이 다시 수집할 수 있습니다. 다시 표시하면 `delete`가 그 결과도 함께 지웁니다.

## 범위 밖

- 등록 기록의 보존·삭제(실패 사용자 정리, 삭제 요청)는 [`recovery.md`](./recovery.md), Blob 사용량 예산과 로그는 [`operations.md`](./operations.md)에 있습니다.
- 실제 WAF rule 생성·Log 관측·action 전환, 실제 CDN에서 `Cache-Control: no-store`와 `Vercel-CDN-Cache-Control`을 함께 쓴 상태 SVG가 cache되는지(`x-vercel-cache`)는 HOST-13 staging에서 확인합니다.
