# HOST-08 bootstrap과 Cron 갱신

새 사용자는 카드 요청을 계기로 bounded bootstrap을 시작합니다. 이미 발행된 사용자는 하루 1회 실행되는 Cron이 시간과 요청 예산 안에서 갱신합니다. 이미지 요청이 전체 GitHub 수집을 동기로 실행하는 일은 없습니다.

## 구성 요소

| 파일 | 책임 |
| --- | --- |
| `src/hosting/refresh-policy.ts` | 갱신 간격과 due 사용자 선정(SSOT) |
| `src/hosting/refresh-job.ts` | 사용자 한 명의 batch 수집 → 발행 → 다음 job 시작 |
| `src/hosting/refresh-dependencies.ts` | Blob store·GitHub token으로 운영 의존성 조립 |
| `src/hosting/bootstrap.ts` | pending 카드 요청의 등록과 background batch 한도 |
| `src/hosting/cron-run.ts` | Cron 한 번의 due 사용자 순회와 예산 |
| `src/hosting/cron-response.ts` | Cron 인증과 응답 |
| `src/hosting/invocation-deadline.ts` | 예산과 Function 종료 시각으로 background deadline 계산 |

## 사용자 한 명의 갱신

`runRefreshJob()`은 아래 두 단계를 최대 한 번씩 실행합니다.

1. `collectStatsBatch()`로 저장된 checkpoint를 이어서 수집합니다. 결과가 `ready`이면 `publishRelease()`로 발행합니다. 발행 결과가 `published`, `unchanged`, `stale` 중 하나이면 manifest에 같은 결과나 더 새로운 snapshot이 들어 있다는 뜻입니다.
2. 발행이 확인됐고 결과의 수집 시각(`period.to`)이 `REFRESH_INTERVAL_MS`(20시간)를 넘었으면 `restartReadyUntil`로 새 job을 시작해 다시 수집하고 발행합니다.

- 미발행 `ready` 결과는 1단계에서 먼저 발행되므로 새 job으로 버려지지 않습니다.
- `publishRelease()`는 렌더링 뒤 manifest를 먼저 확인합니다. 이미 발행된 결과(`unchanged`)나 더 오래된 결과(`stale`)이면 release 객체를 다시 쓰지 않습니다.
- 발행이 `conflict`이면 새 job을 시작하지 않습니다.
- 수집 batch의 deadline은 전체 deadline보다 `PUBLISH_RESERVE_MS`(5초) 앞당깁니다. 발행은 abort signal을 받지 않기 때문입니다.
- 수집 중 checkpoint는 페이지마다가 아니라 10초(`CHECKPOINT_SAVE_INTERVAL_MS`)마다, 그리고 pause·완료·실패 때 저장합니다. checkpoint 쓰기는 Blob Advanced Operation이기 때문입니다. Function이 강제로 끝나면 마지막 저장 뒤 받은 페이지를 다음 batch가 다시 요청하고, 수집이 실패하면 마지막 저장 시점의 진행으로 되돌아갑니다([`operations.md`](./operations.md)).
- 같은 사용자를 동시에 실행하면 checkpoint lease와 조건부 쓰기 때문에 다른 실행은 `busy`나 `conflict`로 끝납니다. 같은 수집 결과는 같은 release 버전이 되므로 중복 발행은 `unchanged`가 됩니다.

## GitHub 요청 실패와 재시도

수집 중 GitHub 요청이 실패하면 오류 종류에 따라 다르게 처리합니다(`retryDecision()`, `src/data/github-pages.ts`).

| 오류 | 처리 | checkpoint |
| --- | --- | --- |
| rate limit(403·429와 `retry-after` 또는 소진된 `x-ratelimit-*`) | 대기 시간과 횟수에 관계없이 reset까지 `paused`. 1시간보다 긴 대기는 1시간으로 줄임 | `retry.nextAttemptAt`만 설정 |
| 대기 헤더 없는 403·429 중 본문 `message`에 `rate limit`이 있는 응답(secondary rate limit) | 1분 뒤까지 `paused`(`secondaryRateLimitDelay()`). 커밋 상세라도 건너뛰지 않음 | `retry.nextAttemptAt`만 설정 |
| 5xx, 응답 전 네트워크 오류 | 1분 → 5분 → 15분 backoff로 최대 3회 `paused`, 그다음 실패는 `failed` | `retry.attempts` 증가 |
| 커밋 상세(`/repos/{repo}/commits/{sha}`)의 rate limit이 아닌 403·404·451 | 그 커밋만 언어 없이 저장하고 다음 커밋으로 진행. 커밋 수·활동일에는 포함하고 언어 비율에서만 빠짐. 언어 없이 cache되므로 다음 수집에서 다시 조회하지 않음 | `metrics.skippedCommits` 증가, `bootstrap.completed`·`cron.completed` 로그의 `skippedCommits` |
| 그 밖의 응답(프로필·저장소·검색의 404 등) | 즉시 `failed` | `error` 기록 |

- `paused`인 사용자는 `nextAttemptAt` 전에는 GitHub 요청 없이 끝나고, 그 뒤 카드 요청의 bootstrap이나 Cron이 이어서 수집합니다. 성공한 요청이 하나라도 있으면 `retry`는 초기화됩니다.
- batch가 rate limit으로 멈추면 결과의 `rateLimitedUntil`에 재시도 가능 시각을 담습니다. 이미 지난 `nextAttemptAt`이 checkpoint에 남아 있어도 rate limit으로 보고하지 않습니다.

## bootstrap

- 카드 route가 `pending`(manifest 없음, 등록됐거나 등록 상한에 여유)으로 응답할 때만 `waitUntil()`로 background batch를 1회 예약합니다. bootstrap은 수집 전에 등록 기록에 등록하며, 카드 요청이 읽은 뒤 다른 요청이 마지막 자리를 가져갔으면 GitHub 요청 없이 끝납니다([`abuse-defense.md`](./abuse-defense.md)). `ready`·`failed`·`capacity`·`invalid-username`·`unavailable` 응답과 GitHub token 또는 Blob store가 설정되지 않은 환경에서는 예약하지 않습니다. 응답 본문과 헤더는 HOST-07과 같습니다.
- 한도는 요청당 `BOOTSTRAP_BUDGET_MS`(20초)와 GitHub 요청 `BOOTSTRAP_MAX_REQUESTS`(20회)입니다. deadline은 Function 종료 시각보다 2초 앞당기고, 수집 job은 다시 2초(`BOOTSTRAP_RECORD_RESERVE_MS`) 일찍 끝내 실패 표시와 사용량 기록을 쓸 시간을 남깁니다. 오늘의 Blob 예산(전체와 bootstrap 몫)에 job 하나가 들어가지 않으면 등록 없이 끝납니다([`operations.md`](./operations.md)). 한 번에 수집이 끝나면 같은 실행에서 발행하고, 끝나지 않으면 checkpoint에 저장해 다음 카드 요청이나 Cron이 이어서 수집합니다.
- `failed`가 된 수집은 bootstrap에서 다시 시작하지 않고(`resumeFailed: false`) 등록 기록에 실패를 표시합니다. 이후 카드 요청은 bootstrap을 예약하지 않고 cache되는 `failed` 상태 SVG를 받습니다. 존재하지 않는 사용자처럼 실패하는 요청이 반복돼도 GitHub API를 다시 호출하지 않으며, 재시도는 Cron이 맡습니다. rate limit과 일시 오류는 `failed`가 아니라 `paused`이므로 대기 시각이 지난 다음 카드 요청에서 이어집니다.
- manifest가 생긴 뒤에는 카드 요청으로 수집하지 않습니다.
- 오류는 메시지만 Function 로그에 남기고 응답에는 영향을 주지 않습니다.

## Cron

- `vercel.json`의 `17 18 * * *`(UTC)에 `/api/cron`을 GET으로 호출합니다. Hobby는 하루 1회까지만 허용하고 실행 시각이 최대 59분 늦을 수 있습니다. 갱신 간격을 24시간보다 짧은 20시간으로 둔 이유이며, freshness는 24~48시간입니다.
- `Authorization: Bearer <CRON_SECRET>`가 일치해야 실행합니다. 상태 코드는 다음과 같습니다.

  | 상황 | 상태 코드 |
  | --- | --- |
  | `CRON_SECRET`이 설정되지 않음 | 503 |
  | 인증 실패 | 401 |
  | GitHub token 또는 Blob store가 설정되지 않음 | 503 |
  | GET이 아닌 요청 | 405 |
  | Blob 목록 조회 실패 | 500 |

- 대상은 private store의 `checkpoints/`, `manifests/` 목록으로 고르며 checkpoint·manifest 본문은 읽지 않습니다. 미발행 사용자의 순서를 정할 때만 등록 기록 하나를 함께 읽습니다. manifest가 20시간 이상 교체되지 않은 발행 사용자를 오래된 순으로 먼저, 그다음 manifest가 없는 사용자(bootstrap 미완료)를 처리합니다. 카드 URL만으로 생긴 checkpoint가 실패를 반복하더라도 이미 카드를 쓰는 사용자의 갱신 예산을 먼저 쓰지 않게 하기 위한 순서입니다.
- 실행 전체 예산은 280초입니다(`maxDuration` 300초, 종료 시각보다 10초 앞당김). GitHub 요청 상한은 실행당 1,000회, 사용자당 시간은 60초입니다. 남은 시간이 발행 여유를 포함해 15초보다 적거나, 요청 상한에 도달하거나, 오늘의 Blob Advanced Operation 예산에 job 하나가 더 들어가지 않으면 멈춥니다. 예산은 시작할 때 읽은 오늘의 사용량 기록으로 구하며, 기록을 읽지 못하면 갱신하지 않습니다([`operations.md`](./operations.md)). 한 사용자의 batch가 GitHub rate limit으로 멈춰도 같은 token을 쓰는 나머지 사용자를 처리하지 않고 멈춥니다. 남은 사용자는 다음 실행이 이어받습니다. 요청 수는 GitHub 요청마다 세므로, 발행이나 저장소 오류로 끝난 사용자가 보낸 요청도 상한에 포함됩니다.
- 사용자 한 명의 저장소·발행 오류는 집계하고 다음 사용자로 넘어갑니다. 수집이 끝난 결과의 발행 실패는 `PublishFailure`로 구분해 `publishFailures`에도 셉니다. `ready` checkpoint가 남으므로 다음 실행은 GitHub 요청 없이 같은 결과의 발행을 다시 시도합니다([`recovery.md`](./recovery.md)).
- 시작할 때 등록 기록을 읽어 실패 표시된 미발행 사용자를 다른 미발행 사용자 뒤에 둡니다. 루프가 끝나면 한 번의 쓰기로 manifest가 있거나 이번에 발행한 사용자의 실패 표시를 지우고, 이번에 발행 없이 `failed`가 된 등록 사용자에 실패를 표시합니다. 삭제 표시된 사용자는 checkpoint가 남아 있어도 갱신하지 않습니다. 실패 표시 후 7일이 지난 미발행 사용자는 갱신 대상에서 빼고 checkpoint를 지운 뒤, 같은 쓰기로 등록 항목도 지웁니다([`recovery.md`](./recovery.md)). 등록 기록 읽기·쓰기는 한 번에 4초 안에서만 실행하며, 실패해도 갱신과 발행은 계속되고 `errors`에 집계합니다([`abuse-defense.md`](./abuse-defense.md)).
- 응답 JSON에는 집계 수치만 담습니다: `due`, `processed`, `published`, `requests`, `errors`, `publishFailures`, 정리한 실패 사용자 수(`expired`), 상태별 개수, 종료 이유(`complete`, `deadline`, `requests`, `rate-limit`, `blob-budget`), Blob 작업 수와 오늘의 예산 사용량(`blob`). 사용자명과 오류 메시지는 넣지 않습니다. 시작 직후 보존 기간이 지난 사용량 기록을 지우고, 실행이 끝나면 오늘의 사용량 기록에 이번 실행을 더합니다.
- Cron 전달은 누락되거나 중복되거나 겹칠 수 있습니다. 매 실행이 목록에서 대상을 다시 고르고 checkpoint lease와 manifest 조건부 교체에 기대므로, 겹친 실행도 사용자별로 한 번만 발행합니다. 누락된 실행은 다음 실행에서 due 판정으로 회복합니다. 실패한 invocation은 Vercel이 재시도하지 않습니다.

## 운영 설정

| 환경 변수 | 용도 |
| --- | --- |
| `BLOB_PRIVATE_STORE_ID`, `BLOB_PUBLIC_STORE_ID` | 카드 조회·bootstrap·Cron의 저장소 |
| `GH_STATS_TOKEN` | bootstrap·Cron의 GitHub 요청 |
| `CRON_SECRET` | Cron 인증. 없으면 Cron이 실행되지 않음 |

카드 Function과 Cron Function은 모두 카드를 렌더링하고 언어를 분류하므로 `includeFiles`로 폰트와 `data/languages.yml`을 포함합니다.

## 범위 밖

- 실제 Vercel Cron 전달, `waitUntil()`·`getDeadline()` 동작, brace glob `includeFiles`의 산출물 포함 여부, 실제 Blob 연결은 HOST-13 staging에서 확인합니다.
- Blob 사용량 예산과 실행 결과의 관측은 [`operations.md`](./operations.md)에 있습니다.
