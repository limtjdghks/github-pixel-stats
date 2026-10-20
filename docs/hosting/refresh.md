# HOST-08 bootstrap과 Cron 갱신

새 사용자는 카드 요청을 계기로 bounded bootstrap을 시작합니다. 이미 발행된 사용자는 하루 1회 실행되는 Cron이 시간과 요청 예산 안에서 갱신합니다. 이미지 요청이 전체 GitHub 수집을 동기로 실행하는 일은 없습니다.

## 구성 요소

| 파일 | 책임 |
| --- | --- |
| `src/hosting/refresh-policy.ts` | 갱신 간격과 due 사용자 선정(SSOT) |
| `src/hosting/refresh-job.ts` | 사용자 한 명의 batch 수집 → 발행 → 다음 job 시작 |
| `src/hosting/refresh-dependencies.ts` | Blob store·GitHub token으로 운영 의존성 조립 |
| `src/hosting/bootstrap.ts` | pending 카드 요청의 background batch 한도 |
| `src/hosting/cron-run.ts` | Cron 한 번의 due 사용자 순회와 예산 |
| `src/hosting/cron-response.ts` | Cron 인증과 응답 |
| `src/hosting/invocation-deadline.ts` | 예산과 Function 종료 시각으로 background deadline 계산 |

## 사용자 한 명의 갱신

`runRefreshJob()`은 아래 두 단계를 최대 한 번씩 실행합니다.

1. `collectStatsBatch()`로 저장된 checkpoint를 이어서 수집합니다. 결과가 `ready`이면 `publishRelease()`로 발행합니다. 발행 결과가 `published`, `unchanged`, `stale` 중 하나이면 manifest에 같은 결과나 더 새로운 snapshot이 들어 있다는 뜻입니다.
2. 발행이 확인됐고 결과의 수집 시각(`period.to`)이 `REFRESH_INTERVAL_MS`(20시간)를 넘었으면 `restartReadyUntil`로 새 job을 시작해 다시 수집하고 발행합니다.

- 미발행 `ready` 결과는 1단계에서 먼저 발행되므로 새 job으로 버려지지 않습니다.
- 발행이 `conflict`이면 새 job을 시작하지 않습니다.
- 수집 batch의 deadline은 전체 deadline보다 `PUBLISH_RESERVE_MS`(5초) 앞당깁니다. 발행은 abort signal을 받지 않기 때문입니다.
- 같은 사용자를 동시에 실행하면 checkpoint lease와 조건부 쓰기 때문에 다른 실행은 `busy`나 `conflict`로 끝납니다. 같은 수집 결과는 같은 release 버전이 되므로 중복 발행은 `unchanged`가 됩니다.

## bootstrap

- 카드 route가 `pending`(manifest 없음)으로 응답할 때만 `waitUntil()`로 background batch를 1회 예약합니다. `ready`·`invalid-username`·`unavailable` 응답과 GitHub token 또는 Blob store가 설정되지 않은 환경에서는 예약하지 않습니다. 응답 본문과 헤더는 HOST-07과 같습니다.
- 한도는 요청당 `BOOTSTRAP_BUDGET_MS`(20초)와 GitHub 요청 `BOOTSTRAP_MAX_REQUESTS`(20회)입니다. deadline은 Function 종료 시각보다 2초 앞당깁니다. 한 번에 수집이 끝나면 같은 실행에서 발행하고, 끝나지 않으면 checkpoint에 저장해 다음 카드 요청이나 Cron이 이어서 수집합니다.
- 실패한 수집(`failed`)은 bootstrap에서 다시 시작하지 않습니다(`resumeFailed: false`). 존재하지 않는 사용자처럼 실패하는 요청이 반복돼도 GitHub API를 다시 호출하지 않으며, 재시도는 Cron이 맡습니다.
- manifest가 생긴 뒤에는 카드 요청으로 수집하지 않습니다.
- 오류는 메시지만 Function 로그에 남기고 응답에는 영향을 주지 않습니다.
- 카드 요청으로 생긴 checkpoint가 곧 등록입니다. 신규 사용자 수 상한, 실패한 사용자 negative cache, WAF는 HOST-10에서 다룹니다.

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

- 대상은 private store의 `checkpoints/`, `manifests/` 목록만으로 고르며 본문은 읽지 않습니다. manifest가 없는 사용자(bootstrap 미완료)를 먼저, 그다음 manifest가 20시간 이상 교체되지 않은 사용자를 오래된 순으로 처리합니다.
- 실행 전체 예산은 280초입니다(`maxDuration` 300초, 종료 시각보다 10초 앞당김). GitHub 요청 상한은 실행당 1,000회, 사용자당 시간은 60초입니다. 남은 시간이 발행 여유를 포함해 15초보다 적거나 요청 상한에 도달하면 멈춥니다. GitHub rate limit으로 재시도가 예약돼도 멈춥니다. 남은 사용자는 다음 실행이 이어받습니다.
- 사용자 한 명의 저장소·발행 오류는 집계하고 다음 사용자로 넘어갑니다.
- 응답 JSON에는 집계 수치만 담습니다: `due`, `processed`, `published`, `requests`, `errors`, 상태별 개수, 종료 이유(`complete`, `deadline`, `requests`, `rate-limit`). 사용자명과 오류 메시지는 넣지 않습니다.
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
- 비용과 실행 결과의 관측은 HOST-11에서 다룹니다.
