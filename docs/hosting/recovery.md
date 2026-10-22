# HOST-11 보존·운영자 CLI·장애 복구

수집에 실패한 미발행 사용자는 Cron이 정해진 기간 뒤 정리합니다. 사용자 데이터 삭제, 마지막 성공 카드로의 rollback, 상태 확인은 공개 endpoint 없이 로컬 운영자 CLI로 합니다. 장애별 확인·조치 절차도 이 문서에 둡니다. Blob 사용량 예산과 로그는 [`operations.md`](./operations.md)에 있습니다.

## 구성 요소

| 파일 | 책임 |
| --- | --- |
| `src/hosting/admission-policy.ts` | 실패 사용자 보존 기간(`FAILED_RETENTION_MS`), 삭제 표시·해제 규칙 |
| `src/hosting/cron-run.ts` | 보존 기간이 지난 실패 사용자 정리, 삭제 표시된 사용자 제외, 발행 실패 집계 |
| `src/storage/manifest.ts` | rollback manifest(`rolledBackManifest()`) |
| `src/hosting/operator.ts` | 운영자 작업: 상태, 사용량, 삭제, 해제, rollback |
| `src/cli/ops.ts`, `src/cli/ops-options.ts` | 운영자 CLI 실행과 인자 해석 |

## 실패 사용자 정리

- 실패 표시(`failedAt`) 후 7일(`FAILED_RETENTION_MS`)이 지난 미발행 사용자는 Cron이 checkpoint와 등록 항목을 지웁니다. 그동안은 Cron이 매일 다시 수집하며, 발행에 성공하면 표시가 지워져 정리 대상에서 빠집니다.
- 실패 표시는 처음 표시한 시각을 유지하므로 7일은 첫 실패부터 셉니다.
- 정리는 Cron이 시작할 때 읽은 등록 기록으로 대상을 고르고, 이번 실행의 갱신 대상에서 뺀 뒤 checkpoint를 지웁니다(delete 무료). 등록 항목은 실행 끝의 등록 기록 정리 쓰기에 함께 지웁니다.
- checkpoint 삭제가 실패하면 그 실행에서는 등록 항목도 지우지 않습니다. 등록 항목만 지우면 checkpoint만 남은 사용자가 실패 표시 없이 다시 수집되기 때문입니다. 다음 실행이 다시 시도합니다.
- 지워진 사용자는 다음 카드 요청에서 신규 사용자로 다시 등록되며 신규 등록 상한을 다시 씁니다.
- Cron 응답과 `cron.completed` 로그의 `expired`가 이번 실행에서 정리한 사용자 수입니다.

## 삭제 표시

- 운영자가 사용자를 삭제하면 등록 기록에 `removedAt`을 남깁니다. 등록된 적이 없는 사용자도 표시합니다.
- 표시된 사용자의 카드 요청은 manifest가 없으면 `removed` 상태 SVG로 응답합니다(`Cache-Control: no-store`, `Vercel-CDN-Cache-Control: max-age=3600`). bootstrap은 등록하지 않고, Cron은 checkpoint가 남아 있어도 갱신하지 않습니다.
- 삭제 표시된 사용자는 신규·active 상한 어느 쪽에도 세지 않습니다.
- `removedAt`이 생기기 전에 쓴 등록 기록 항목은 표시 없음으로 읽습니다.

## 운영자 CLI

### 준비

CLI는 Function과 같은 Blob adapter(`@vercel/oidc` token + store ID)를 씁니다. 저장소 루트에서 Vercel 프로젝트를 연결하고 환경 변수를 받은 뒤 실행합니다.

```bash
vercel link
vercel env pull --environment=production .env.ops
```

`.env.ops`의 `VERCEL_OIDC_TOKEN`, `BLOB_PRIVATE_STORE_ID`, `BLOB_PUBLIC_STORE_ID`를 환경 변수로 넘깁니다. 이 파일은 commit하지 않습니다.

```bash
node --env-file=.env.ops --import tsx src/cli/ops.ts status
```

로컬 OIDC token으로 운영 store에 접근할 수 있는지, token이 만료되면 어떻게 갱신되는지는 HOST-13 staging에서 확인합니다. 확인 전까지 위 절차는 가정입니다.

### 명령

결과는 JSON으로 출력합니다. 사용자명은 운영자 터미널에만 출력되며 로그로 보내지 않습니다.

| 명령 | 동작 | Blob 작업(대략) |
| --- | --- | --- |
| `status` | 발행·미발행 사용자 수, 실패·삭제 표시된 사용자, 발행이 멈춘 사용자(`stuck`), 손상돼 판단하지 못한 checkpoint(`unreadable`) | list 2, 읽기 1 + 후보 checkpoint 읽기 |
| `usage [--days N]` | 최근 N일(기본 7, 최대 90)의 일별 사용량 기록 | 읽기 N |
| `delete <user> [--yes]` | 삭제 표시 후 manifest·checkpoint·release·카드 삭제. `--yes`가 없으면 지울 대상(`planned`)만 출력 | list 4~6, 읽기·쓰기 몇 회 |
| `restore <user>` | 삭제 표시를 풀고 등록 항목을 지움 | 읽기 2, 쓰기 1 |
| `rollback <user> [--yes]` | checkpoint 삭제 후 직전 release를 current로 승격. `--yes`가 없으면 바뀔 내용만 출력 | 읽기 2, 쓰기 1 |

CLI 작업도 Blob 포함량을 쓰지만 일별 사용량 기록에는 들어가지 않습니다. `DAILY_ADVANCED_BUDGET`을 월 포함량의 하루 몫보다 작게 둔 이유 중 하나입니다.

### 발행이 멈춘 사용자

`status`의 `stuck`은 수집이 끝난 결과(`ready` checkpoint)가 발행되지 않은 채 24시간(`STUCK_PUBLISH_MS`) 넘게 그대로인 사용자입니다. 검증·렌더링이 항상 실패하는 결과라면 Cron이 매일 같은 결과의 발행을 다시 시도하다 실패하고, 카드는 마지막 성공 상태에 멈춥니다. 자동으로 다시 수집하지 않습니다.

- Cron 응답·`cron.completed` 로그·일별 사용량 기록의 `publishFailures`가 발행 실패 수입니다. `cron.publish_failed` 로그에 오류 메시지가 남습니다.
- 후보는 checkpoint가 마지막 발행보다 새롭고 24시간 넘게 바뀌지 않은 사용자이며, 그 checkpoint 본문이 `ready`인 경우만 보고합니다. 예산이 모자라 차례를 기다리는 `paused` 사용자는 넣지 않습니다.
- 후보 checkpoint가 손상돼 읽지 못하면 상태 명령을 실패시키지 않고 `unreadable`에 넣습니다. 손상된 checkpoint는 Cron이 매번 실패하므로, dashboard에서 그 객체를 지우면 다음 갱신에서 새로 수집합니다.
- 조치:
  1. 오류 메시지로 원인을 찾습니다. renderer·검증 버그라면 코드를 고쳐 배포하면 다음 Cron이 같은 결과를 새 renderer로 발행합니다.
  2. 결과 자체가 잘못됐다면 그 사용자를 `rollback`하거나, checkpoint를 지워 다음 갱신에서 새로 수집하게 합니다.

### 삭제 요청

1. 요청자가 해당 GitHub 계정의 소유자인지 확인합니다. 확인 방식은 출시 전 결정 게이트이며 아직 정하지 않았습니다.
2. `delete <user>`로 지울 대상을 확인합니다.
3. `delete <user> --yes`로 삭제합니다. 결과의 `remaining`이 비어 있지 않으면 삭제 도중 실행 중이던 수집·발행이 쓴 객체이므로 같은 명령을 다시 실행합니다.
4. 요청자에게 다음을 안내합니다.
   - Vercel CDN에 cache된 카드 응답은 최대 12시간(그 뒤 stale 응답 1회) 남을 수 있습니다.
   - README에서 카드 URL을 지우는 것은 요청자가 해야 합니다.
   - 지운 Blob 객체가 Blob CDN에서 사라지는 시간은 HOST-13에서 확인합니다.
5. 다시 쓰고 싶다는 요청이 오면 `restore <user>`로 표시를 풉니다. 다음 카드 요청부터 신규 등록 상한 안에서 다시 수집됩니다.

### rollback

1. `rollback <user>`로 바뀔 release(`from` → `to`)를 확인합니다.
2. `rollback <user> --yes`로 실행합니다. 순서는 다음과 같습니다.
   - checkpoint를 먼저 지웁니다. 남겨 두면 잘못된 결과의 `ready` checkpoint가 다음 Cron에서 다시 발행됩니다.
   - 직전 release를 current로 올리고 previous는 비웁니다. 잘못된 release는 퇴역 목록으로 옮겨 1시간 유예 뒤 다음 발행의 정리 단계에서 지워집니다.
3. 다음 갱신은 manifest 교체 시각부터 20시간(`REFRESH_INTERVAL_MS`)이 지난 Cron에서 새 수집으로 시작합니다. 그 전에 원인을 고쳐 배포해야 같은 문제가 다시 발행되지 않습니다.
4. Vercel CDN에 cache된 카드 응답은 cache가 만료될 때까지 남으므로, 잘못된 카드가 최대 12시간(그 뒤 stale 응답 1회) 더 보일 수 있습니다.

- 직전 release가 없거나 그 사용자의 수집 lease가 살아 있으면 아무것도 바꾸지 않고 오류로 끝납니다. lease가 끝난 뒤 다시 실행합니다.
- checkpoint를 지운 뒤 manifest가 바뀌어 있으면(그 사이 다른 발행이 끼어든 경우) manifest는 그대로 두고 오류로 끝나며, **checkpoint는 이미 지워진 상태입니다.** 이때 그대로 `--yes`로 다시 실행하면 안 됩니다. 끼어든 발행이 previous를 되돌리려던 release로 바꿨을 수 있어, 잘못된 release가 current로 올라갈 수 있기 때문입니다. `--yes` 없이 미리보기부터 다시 실행해 `from`·`to`를 확인한 뒤 진행합니다.
- 한 번 rollback하면 previous가 비므로 연속으로 두 단계를 되돌릴 수는 없습니다.

## 장애별 절차

| 장애 | 증상 | 자동 동작 | 운영자 조치 |
| --- | --- | --- | --- |
| Blob 일시 장애 | 발행 전 사용자 `unavailable`. Cron 500(목록 조회 실패) 또는 `errors` 증가 | 발행 카드는 CDN cache와 SWR로 계속 응답. `unavailable`은 cache하지 않음 | Vercel status 확인. 복구 뒤 다음 Cron이 이어서 처리. 필요하면 Cron을 수동 실행 |
| Blob 포함량 초과 | 모든 Blob 요청 실패. 30일 동안 접근 불가 | 일일 예산 guard가 Cron·bootstrap 몫을 막지만, 카드 읽기·CLI·dashboard 사용은 막지 않음 | Usage에서 원인 확인. 기다리거나 Pro 전환. [`operations.md`](./operations.md)의 처리량 절 검토 |
| GitHub rate limit·5xx | `paused` 증가, `stopped: "rate-limit"` | reset까지 대기, 5xx는 backoff 3회 | 대개 없음. 반복되면 Cron 요청 상한 검토 |
| GitHub token 만료·권한 오류 | 수집이 401·403으로 `failed`. 실패 표시 급증 | 미발행 사용자는 실패 표시 7일 뒤 정리됨. 발행 사용자는 마지막 성공 카드 유지 | `GH_STATS_TOKEN`을 바로 교체. **7일 안에 교체하지 않으면 그동안 실패한 미발행 사용자의 등록이 지워짐** |
| Cron 누락·실패 | `cron.completed` 로그 없음, 또는 `cron.failed` | 다음 실행이 due 판정으로 회복. 실패한 invocation은 Vercel이 재시도하지 않음 | 원인 확인 뒤 dashboard의 Cron Jobs에서 수동 실행하거나 `Authorization: Bearer $CRON_SECRET`으로 `/api/cron` 호출 |
| 잘못된 배포(코드) | 오류 증가, 카드 이상 | 없음 | Vercel에서 이전 deployment로 instant rollback. CDN cache는 deployment별이라 이전 deployment의 항목이 다시 쓰일 수 있음 |
| 잘못된 카드 발행(renderer·데이터) | 특정 사용자 카드 이상 | 없음 | 원인 수정·배포 뒤 해당 사용자 `rollback`. 여러 사용자면 사용자별로 실행 |
| 발행이 계속 실패 | `publishFailures` 반복, `status`의 `stuck` | 마지막 성공 카드 유지 | 위 "발행이 멈춘 사용자" 절차 |
| manifest 손상 | 그 사용자 카드 `unavailable`, Cron에서 그 사용자 오류 | 없음. CLI `rollback`도 manifest를 읽지 못해 실패 | dashboard에서 그 manifest 객체를 지움. 사용자는 미발행 상태가 되어 checkpoint로 다시 수집·발행됨 |
| 등록 기록 손상 | 미발행 사용자 모두 `unavailable`, bootstrap 중단 | fail-closed | [`abuse-defense.md`](./abuse-defense.md)의 등록 기록 손상 절차 |
| 사용량 기록 손상 | 그날 Cron·bootstrap 수집 중단, `cron.usage_read_failed` | fail-closed. 날짜가 바뀌면 새 기록으로 회복 | 그날 안에 회복이 필요하면 그 날짜 객체를 고치거나 지움. 지우면 그날 예산 집계가 0부터 다시 시작돼 하루 예산을 넘을 수 있음 |

- dashboard에서 Blob store를 열거나 객체를 지우는 것도 Advanced Operation입니다.
- Cron을 수동으로 실행하면 그날 Cron 몫을 다시 씁니다. 사용량 기록이 실행마다 더해지므로 예산 guard는 그대로 동작합니다.

## 범위 밖

- 실제 store에서의 CLI 인증, 지운 Blob 객체의 Blob CDN 잔존 시간, manifest 손상·rollback·삭제 복구 연습은 HOST-13 staging에서 합니다.
- 삭제 요청자의 GitHub 계정 소유권 확인 방식은 출시 전 결정 게이트입니다.
