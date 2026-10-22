# HOST-11 Blob 사용량 예산과 운영 관측

Hobby의 Vercel Blob은 포함량을 넘어도 과금하지 않습니다. 대신 Blob 접근이 막히고 30일을 기다려야 하며, 이 서비스에서는 카드 제공 전체가 멈춥니다. 그래서 Cron과 bootstrap이 쓰는 Blob 작업을 세고, 일일 예산 안에서만 새 수집을 시작합니다. 실행 결과는 private store의 일별 사용량 기록과 Function 로그로 확인합니다.

## 구성 요소

| 파일 | 책임 |
| --- | --- |
| `src/hosting/usage-policy.ts` | 일일 예산, job 추정치, 보존 기간, 예산 판정과 기록 합산 규칙(SSOT) |
| `src/storage/usage.ts` | 일별 사용량 기록 형식·검증, ETag 조건부 갱신, 보존 기간 정리 |
| `src/storage/operation-count.ts` | 실행 범위(async context)별 Blob 작업 집계 store |
| `src/hosting/log.ts` | 한 줄 JSON 로그 이벤트 |

## Hobby 포함량

[Vercel Blob Pricing](https://vercel.com/docs/vercel-blob/usage-and-pricing)(2026-09-23 갱신본) 기준입니다.

| 항목 | 월 포함량 | 세는 작업 |
| --- | ---: | --- |
| Advanced Operations | 2,000회 | put·copy·list, store 생성, 대시보드에서 store 탐색 |
| Simple Operations | 10,000회 | URL 접근 중 cache MISS, metadata 조회 |
| Storage | 1 GB | 월 평균 크기 |
| Blob Data Transfer | 10 GB | 다운로드 |

- delete는 무료입니다.
- 포함량은 프로젝트의 모든 Vercel 서비스가 공유합니다.
- 대시보드에서 Blob store를 둘러보는 것도 Advanced Operation이라 일일 예산에서 몫을 남겨 둡니다.

## 작업을 줄이는 설정

| 대상 | 설정 | 이유 |
| --- | --- | --- |
| 수집 checkpoint | 10초(`CHECKPOINT_SAVE_INTERVAL_MS`)마다, 그리고 pause·완료·실패 때만 저장 | 페이지마다 저장하면 쓰기 수가 GitHub 요청 수와 같아짐 |
| 발행 카드 CDN cache | `max-age=43200`(12시간), SWR 하루 | CDN miss마다 manifest·카드 Blob 읽기(Simple) 2회가 생김 |

- checkpoint 간격 안에서 받은 페이지는 Function이 강제로 끝나면 사라지고, 다음 batch가 같은 페이지를 다시 요청합니다. 수집이 실패하면 마지막 저장 시점의 진행으로 되돌아갑니다. GitHub 요청 한도(시간당 5,000회)가 Blob 한도보다 훨씬 커서 받아들일 만한 손실입니다.
- 카드 cache 변경에 따른 freshness는 [`card-route.md`](./card-route.md)에 있습니다.

## 일일 예산

UTC 하루 단위입니다. 값은 `usage-policy.ts` 상수로만 바꿉니다.

| 상수 | 값 | 의미 |
| --- | ---: | --- |
| `DAILY_ADVANCED_BUDGET` | 60 | Cron·bootstrap 합계. 월 2,000회(하루 약 64회)에서 대시보드·운영 작업 몫을 뺀 값 |
| `BOOTSTRAP_DAILY_ADVANCED_BUDGET` | 26 | 그중 bootstrap 몫. 발행까지 끝나는 bootstrap 약 2회 |
| `JOB_ADVANCED_ESTIMATE` | 12 | 발행까지 끝나는 job 하나의 추정치 |

job 하나의 추정치는 다음 작업의 합입니다.

| 작업 | 횟수 |
| --- | ---: |
| 등록 기록 등록(bootstrap) | 1 |
| checkpoint lease 획득·진행·완료 저장 | 2~3 |
| 발행 쓰기(snapshot, state, 카드 2개, manifest) | 5 |
| 퇴역 release 정리 list(private·public) | 2 |

- Cron은 시작할 때 오늘 기록을 읽어 남은 몫(`DAILY_ADVANCED_BUDGET` − 오늘 합계 − 기록 쓰기 1)을 구합니다. 이번 실행이 쓴 작업에 추정치를 더한 값이 남은 몫을 넘으면 다음 사용자를 시작하지 않고 `stopped: "blob-budget"`으로 끝납니다. 시작할 때의 목록 조회 2회도 이번 실행 작업에 들어갑니다.
- bootstrap은 등록 전에 오늘 기록을 읽어, 전체 예산과 bootstrap 몫 모두에 추정치와 기록 쓰기 1회가 들어갈 때만 진행합니다. 들어가지 않으면 등록하지 않고 `bootstrap.skipped` 로그만 남기며, 그 사용자는 다음 카드 요청이나 날짜가 바뀐 뒤 다시 시도됩니다. 이미 등록된 미발행 사용자는 Cron이 이어서 수집합니다.
- 사용량 기록을 읽지 못하거나 손상됐으면 예산을 알 수 없으므로 Cron은 갱신하지 않고, bootstrap은 진행하지 않습니다(fail-closed). 날짜가 바뀌면 새 기록을 쓰므로 손상된 기록은 그날만 영향을 줍니다.
- 발행 카드 응답은 사용량 기록을 읽지 않아 예산과 관계없이 계속 제공됩니다.
- 추정치는 상한이 아닙니다. 실제 job이 더 많이 쓰거나 bootstrap이 동시에 여러 개 시작되면 예산을 조금 넘을 수 있으며, 일일 예산을 월 포함량의 하루 몫보다 작게 둔 이유입니다.
- Cron과 bootstrap은 모두 시작할 때 읽은 기록으로 판정하고 끝날 때 더합니다. 그래서 Cron이 도는 동안(최대 280초) 시작한 bootstrap은 Cron이 쓰고 있는 몫을 보지 못합니다. 이 경우 그날 합계는 최대 bootstrap 몫(26회)만큼 예산을 넘을 수 있습니다(약 86회). Cron은 하루 한 번이라 겹칠 수 있는 시간이 짧아 지금은 막지 않으며, HOST-13 실측 후 Cron 시작 시 예약·정산 방식을 검토합니다.

### 처리량

Advanced Operation 기준으로 하루에 처리할 수 있는 양은 대략 다음과 같습니다(코드 기준 추정, 실측은 HOST-13).

- bootstrap이 몫을 다 쓴 날 Cron 몫은 약 33회입니다. 목록 조회 2회를 빼면 발행까지 끝나는 갱신 약 2명분입니다.
- bootstrap이 없는 날은 약 4명을 갱신합니다.
- Cron은 오래된 발행 사용자부터 갱신하므로 사용자가 이보다 많으면 매일 갱신되지 않고 차례로 갱신됩니다. 그만큼 freshness가 길어집니다.
- HOST-10의 active 상한 20명을 모두 매일 갱신할 수는 없습니다. 상한 조정, 발행 쓰기 감소, Pro 전환은 epic 출시 전 결정 게이트에서 다룹니다.

## 일별 사용량 기록

private store의 `usage/YYYY-MM-DD.json`(UTC 날짜)에 하루 동안의 누적을 둡니다. 같은 날 여러 실행이 동시에 더할 수 있으므로 ETag 조건부 교체로만 바꾸고, 충돌하면 다시 읽어 최대 5번 다시 더합니다.

| 필드 | 내용 |
| --- | --- |
| `blob.advanced`, `blob.simple` | Cron·bootstrap이 쓴 Blob 작업 합계. 기록 자체의 작업(실행마다 Advanced 1회, 시작 시 읽기를 포함한 Simple 2회)도 포함 |
| `cron` | 실행 수(`runs`), 처리·발행 사용자 수, GitHub 요청 수, 오류 수 |
| `bootstrap` | 실행 수, 발행 수, GitHub 요청 수, bootstrap 몫 Advanced 합계(`advanced`) |

GitHub 요청 수는 요청마다 세므로, job이 발행이나 저장소 오류로 끝나도 이미 보낸 요청이 들어갑니다(Cron·bootstrap 같은 기준).

- 작업 수는 `countOperations()` 범위 안에서 `createRefreshDependencies()`의 저장소를 거친 작업만 셉니다. 한 Function 인스턴스가 여러 요청을 동시에 처리해도 실행마다 따로 셉니다.
- 쓰기와 list는 Advanced, 읽기는 Simple로 셉니다. Simple은 Blob CDN hit도 세므로 실제보다 많은 상한입니다. list는 호출당 1회로 세므로 한 prefix가 1,000개를 넘으면 실제보다 적습니다. 조건이 맞지 않아 실패한 쓰기도 셉니다.
- 기록 쓰기 자체의 재시도 작업은 세지 않습니다.
- bootstrap은 Advanced Operation을 쓴 실행만 기록합니다. 읽기만 하고 끝난 실행(상한 도달, 실패 표시된 사용자)까지 기록하면 기록 쓰기가 예산을 쓰기 때문입니다.
- **카드 응답 경로의 Blob 읽기는 들어 있지 않습니다.** 응답 경로는 저장소에 쓰지 않는 계약이라 셀 수 없습니다. Vercel dashboard의 Blob Observability로 확인합니다.
- Cron은 매 실행 시작 직후 90일(`USAGE_RETENTION_DAYS`) 지난 기록을 지웁니다. list 없이 보존 기간 바로 뒤 7일의 pathname을 직접 지우므로(delete 무료), 7일 동안 Cron이 한 번도 돌지 않으면 그 날짜 기록은 남습니다. delete는 abort signal을 받지 않아 deadline 여유를 쓰지 않도록 시간이 넉넉한 시작 직후에 실행합니다.

## Cron 응답

기존 집계에 `blob`이 더해졌습니다.

| 필드 | 내용 |
| --- | --- |
| `blob.operations` | 이번 실행의 Advanced·Simple 수(기록 쓰기 포함) |
| `blob.dailyAdvanced` | 이번 실행을 더한 오늘 Advanced 합계. 기록을 쓰지 못했으면 null |
| `blob.dailyBudget` | `DAILY_ADVANCED_BUDGET` |
| `stopped` | 기존 값에 `blob-budget` 추가 |

사용량 기록 읽기·쓰기 실패와 보존 정리 실패는 `errors`에 집계합니다. 등록 기록과 사용량 기록의 읽기·쓰기는 한 번에 4초 안에서만 실행합니다.

## 로그

Function 로그는 모두 한 줄 JSON입니다. Vercel 런타임 로그에서 `event`로 걸러 봅니다. 사용자명과 Secret은 넣지 않고, 오류는 메시지만 남깁니다.

| `event` | level | 필드 |
| --- | --- | --- |
| `card.response` | info | `card`(`stats`·`languages`), `status`(`ready`, 상태 SVG 이름, `redirect`) |
| `card.read_failed`, `card.pending_hook_failed` | error | `error` |
| `bootstrap.completed` | info | `status`, `publish`, `requests`, `blobAdvanced`(기록 쓰기를 뺀 이 실행의 Advanced 수) |
| `bootstrap.skipped` | info | `reason: "blob-budget"` |
| `bootstrap.failed`, `bootstrap.usage_update_failed` | error | `error` |
| `cron.completed` | info | Cron 응답 집계, `blobAdvanced`, `blobSimple`, `dailyAdvanced`, `dailyBudget` |
| `cron.failed`, `cron.refresh_failed`, `cron.admissions_*_failed`, `cron.usage_*_failed` | error | `error` |

- `card.response`는 Function까지 온 요청만 남습니다. CDN hit은 Function을 거치지 않으므로, `card.response` 수를 실제 카드 조회 수로 보면 안 됩니다. 발행 카드의 `ready` 수가 CDN miss 수에 해당합니다.
- Hobby의 런타임 로그는 보존 기간이 짧습니다. 장기 추세는 일별 사용량 기록으로 봅니다.

## 확인 절차

1. Vercel dashboard의 Usage에서 Blob Advanced·Simple Operations의 이번 달 누적을 확인합니다. 월 포함량의 80%에 가까우면 남은 날짜와 일일 예산을 비교합니다.
2. Blob Observability에서 카드 응답 경로를 포함한 실제 작업 수를 확인하고, 일별 사용량 기록의 `blob.advanced`와 비교합니다. 차이가 크면 job 추정치나 집계 방식을 다시 봅니다. job 하나의 실제 값은 발행까지 끝난 `bootstrap.completed`의 `blobAdvanced`로 보고 `JOB_ADVANCED_ESTIMATE`(12)와 비교합니다.
3. Cron의 `cron.completed` 로그나 응답에서 `stopped`가 자주 `blob-budget`이면 처리량이 사용자 수보다 적다는 뜻입니다. freshness와 처리량 절의 선택지를 검토합니다.
4. 일별 기록을 dashboard에서 열어 보는 것도 Advanced Operation입니다. 자주 확인해야 하면 HOST-11 ②의 운영자 CLI로 읽습니다.

## 범위 밖

- 실패 사용자 자동 정리, 운영자 삭제·rollback CLI, 장애 복구 runbook은 HOST-11 ②입니다.
- 실제 Blob 사용량과 집계값의 차이, job 하나의 실제 Advanced 수, Hobby 런타임 로그 보존 기간, 실제 CDN의 12시간 cache 적용은 HOST-13 staging에서 확인합니다.
- 오류 로그는 메시지를 그대로 남깁니다. Blob SDK나 발행 경로의 오류 메시지에 pathname(`checkpoints/{user}.json` 등)이나 사용자명이 들어가는지는 HOST-13에서 실제 메시지로 확인하고, 들어가면 마스킹 방식을 정합니다.
