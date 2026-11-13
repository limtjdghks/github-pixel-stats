# HOST-13 ② 운영 구성과 출시 기준

운영 Vercel 프로젝트의 구성, 배포·rollback 방식, 출시 게이트와 비용 기준입니다. 결정과 경위는 Issue #33에 있고, 검증 환경은 [`staging.md`](./staging.md)에 있습니다.

## 구성

| 항목 | 값 |
| --- | --- |
| Vercel 프로젝트 | `github-pixel-stats-hosted`(Hobby) |
| 도메인 | `github-pixel-stats-hosted.vercel.app`(기본 `*.vercel.app` 도메인). custom domain은 쓰지 않습니다 |
| 배포 | Vercel Git 연동. Production branch는 `main` |
| Blob store | `gps-prod-private`(private), `gps-prod-public`(public). 둘 다 `iad1`, Production·Development 환경에만 연결 |
| Cron | `vercel.json`의 `17 18 * * *`(UTC). Hobby Cron은 지정한 시(hour) 안의 아무 때나 실행되므로 실제로는 18:00~18:59 UTC 사이에 실행됩니다 |
| WAF | rate-limit rule `card rate limit (log)` 1개(2026-11-12 생성, firewall 설정 버전 1). 조건은 path가 `.svg`로 끝나거나 `/api/card`로 시작, key는 IP, fixed window 60초·300회, 초과 시 action은 **Log**입니다. Log를 관측한 뒤 429로 바꾸고 이 표를 갱신합니다([`abuse-defense.md`](./abuse-defense.md#waf-rate-limit)) |

staging과 store·Secret을 공유하지 않습니다. Blob 포함량은 계정 단위라 두 프로젝트가 같은 Hobby 포함량을 쓰지만, 일일 예산은 store마다 따로 판정합니다. 그래서 운영을 여는 시점에 staging 프로젝트의 Cron을 끕니다. staging에서 다시 검증할 때는 Cron을 켜고, 그 기간의 staging 사용량을 운영 예산과 합쳐 포함량 안에 드는지 확인합니다.

### 환경 변수

| 이름 | 종류 | Production | Preview | Development |
| --- | --- | --- | --- | --- |
| `BLOB_PRIVATE_STORE_ID`, `BLOB_PUBLIC_STORE_ID` | 일반 | 운영 store | 없음 | 없음 |
| `VERCEL_BLOB_RETRIES` | 일반 | `3` | 없음 | 없음 |
| `GH_STATS_TOKEN` | Sensitive | 운영 token | 없음 | 없음 |
| `CRON_SECRET` | Sensitive | 운영 값 | 없음 | 없음 |

- Secret 값은 운영자가 dashboard나 `vercel env add`로 직접 입력합니다. 저장소, 로그, 문서에 남기지 않습니다.
- store ID를 Sensitive로 두지 않는 이유와 store 연결 시 자동 생성되는 `BLOB_READ_WRITE_TOKEN`은 [`staging.md`](./staging.md#설정에서-알게-된-것)에 있습니다.
- 운영 store를 Development 환경에도 연결하는 이유는 운영자 CLI가 쓰는 로컬 OIDC token이 development 환경용이기 때문입니다([`recovery.md`](./recovery.md#준비)). store ID 변수는 Production에만 두고, CLI는 `vercel env pull --environment=production`으로 받습니다. Development에 store ID가 없으므로 `vercel dev`나 기본 `vercel env pull`만으로는 운영 store를 가리키지 않습니다. 그래도 `.env.ops`에는 운영 store에 쓸 수 있는 OIDC token이 들어가므로 작업이 끝나면 지웁니다.

### GitHub token

- fine-grained personal access token을 90일 유효기간으로 발급합니다. 조직은 fine-grained token의 최대 유효기간을 정할 수 있고, 그보다 긴 token으로는 그 조직 저장소의 커밋 상세 조회가 403이 되어 그 커밋의 언어가 빠집니다([`staging.md`](./staging.md)). staging에서 만난 조직의 상한은 366일이었고, 더 짧은 상한을 둔 조직도 있을 수 있어 짧게 발급합니다.
- 공개 사용자·저장소·커밋 조회만 하므로 저장소 접근은 "Public repositories (read-only)"로 둡니다.
- 만료 2주 전까지 새 token을 발급해 Production `GH_STATS_TOKEN`을 교체하고 다시 배포합니다. 만료되면 401 처리([`recovery.md`](./recovery.md#장애별-절차))로 수집이 멈추고 마지막 성공 카드가 유지됩니다.

## Git 연동과 Preview

- `main`에 push(병합)하면 Production으로 배포됩니다. 그 밖의 브랜치 push와 PR은 Preview로 배포됩니다.
- Preview에는 store와 Secret이 없습니다. 형식이 올바른 카드 요청은 `unavailable` 상태 SVG를 받고, bootstrap은 실행되지 않습니다. Vercel Cron은 Production deployment만 호출합니다.
- Preview URL은 Vercel Deployment Protection으로 로그인한 팀 구성원만 열 수 있습니다(외부 요청은 302).
- 프로젝트에 Production deployment가 없을 때 처음 만들어진 deployment는 브랜치와 관계없이 Production 도메인을 받았습니다. 2026-11-12 첫 배포에서 `dev` 브랜치(PR #38)의 deployment가 Production이 됐고, `main` 병합 뒤 `main` deployment로 바뀌었습니다. 새 프로젝트를 Git에 연결할 때는 첫 push 대상을 확인합니다.
- 저장소가 public이라 fork PR도 Preview 대상입니다. Git Fork Protection이 켜져 있으면 Vercel은 팀 구성원이 아닌 작성자의 fork PR을 배포하기 전에 PR comment로 승인을 요청합니다. 운영 프로젝트의 Git Fork Protection은 켜져 있습니다(2026-11-12 Vercel API `gitForkProtection: true`로 확인). 같은 계정으로는 자기 저장소를 fork할 수 없어 실제 fork PR로는 확인하지 못했습니다. 코드를 확인하기 전에는 승인하지 않습니다. Preview에 운영 값이 없으므로 승인한 fork PR도 운영 store와 token에 접근하지 못합니다.
- Vercel 원격 빌드는 `npm run build`만 실행합니다. Function 산출물 검사(`validate:vercel-output`)는 PR CI가 `vercel build` 뒤에 실행합니다([`ci.md`](./ci.md)).

## Rollback

| 대상 | 방법 | 주의 |
| --- | --- | --- |
| 잘못된 배포(코드) | Vercel Instant Rollback | Hobby는 바로 이전 deployment로만 되돌릴 수 있습니다. rollback하면 Production 도메인 자동 할당이 꺼져, 이후 `main` 병합이 운영에 반영되지 않습니다. 원인을 고쳐 배포한 뒤 dashboard의 promote나 `vercel promote <deployment>`로 자동 할당을 다시 켭니다 |
| 잘못된 카드 발행(데이터) | 운영자 CLI `ops rollback <user>` | [`recovery.md`](./recovery.md#rollback) |

## 출시 게이트

출시 시점의 값은 코드 상수 그대로이며 pilot 결과를 보고 조정합니다. 값을 바꿀 때는 상수와 이 표를 함께 고칩니다.

| 게이트 | 값 | 상수 |
| --- | --- | --- |
| 일일 신규 사용자 | 24시간에 5명 | `NEW_USER_WINDOW_MS`, `NEW_USER_LIMIT`([`abuse-defense.md`](./abuse-defense.md#상한)) |
| active 사용자 | 20명 | `ACTIVE_USER_LIMIT` |
| 갱신 간격 | 마지막 발행 20시간 뒤부터 다음 Cron에서 갱신 | `REFRESH_INTERVAL_MS`([`refresh.md`](./refresh.md)) |
| Blob Advanced 일일 예산 | 60회(그중 bootstrap 26회), job 추정치 10회 | `DAILY_ADVANCED_BUDGET`, `BOOTSTRAP_DAILY_ADVANCED_BUDGET`, `JOB_ADVANCED_ESTIMATE`([`operations.md`](./operations.md#일일-예산)) |

### Freshness

- 하루 처리량은 발행까지 끝나는 갱신 약 2~4명입니다([`operations.md`](./operations.md#처리량)). 발행 사용자가 이 수 이하이면 freshness는 24~48시간이고, CDN cache 때문에 최대 12시간이 더해집니다([`card-route.md`](./card-route.md)).
- 발행 사용자가 처리량보다 많으면 Cron이 오래된 사용자부터 차례로 갱신합니다. active 상한 20명을 다 채우면 한 사용자의 갱신 간격은 약 5~10일로 늘어납니다.
- 신규 사용자는 수집이 끝날 때까지 `pending` 카드를 받습니다. Cron은 사용자당 60초 동안 GitHub 요청 약 170~190회를 처리하므로, staging에서 커밋 716개 계정(요청 약 720회)은 bootstrap 1회와 Cron 약 4회 뒤에 첫 카드를 받았습니다([`staging.md`](./staging.md)).
- Cron은 갱신할 때가 된 발행 사용자를 미발행 사용자보다 먼저 처리합니다(`selectDueUsers`). 발행 사용자가 처리량보다 많으면 Cron 예산을 갱신이 모두 쓰고, 신규 사용자는 카드 요청 bootstrap(실행당 GitHub 20회, 하루 bootstrap 몫 약 2회)으로만 진행되어 첫 카드까지 수일에서 수주가 걸릴 수 있습니다.

## Vercel Usage 예상치

Hobby 월 포함량은 [`operations.md`](./operations.md#hobby-포함량)에 있습니다. 아래는 출시 전 추정이며 pilot 동안 Usage와 일별 사용량 기록으로 확인합니다.

| 항목 | 예상 | 근거 |
| --- | --- | --- |
| Blob Advanced | 월 최대 약 1,800~1,860회(포함량 2,000회) | 일일 예산 60회 × 30~31일. 예산이 상한이 아니라서 넘을 수 있습니다([`operations.md`](./operations.md#일일-예산)). staging Cron을 끈 상태 기준이며, 켜면 staging 사용량이 더해집니다 |
| Blob Simple | 카드 URL·CDN region 조합마다 하루 약 4회 | 발행 카드 CDN miss마다 읽기 2회, 12시간 cache로 miss는 하루 약 2회. active 20명(카드 URL 40개)이 한 region에서만 읽히면 월 약 4,800회, 세 region이면 포함량 10,000회를 넘습니다 |
| Function·CDN 요청 | 정상 트래픽은 포함량 대비 작을 것으로 예상 | 발행 카드는 CDN이 응답합니다. 임의 query로 cache를 우회하는 대량 요청은 WAF rule이 429로 바뀐 뒤에야 막히며, Log 단계에서는 Function·CDN 요청과 Simple Operation을 그대로 늘립니다([`abuse-defense.md`](./abuse-defense.md#waf-rate-limit)) |

Blob 포함량을 넘으면 30일 동안 Blob 접근이 막혀 카드 제공 전체가 멈춥니다. 월중 Usage가 80%에 가까우면 다음과 같이 합니다.

- Advanced: [`operations.md`](./operations.md#확인-절차)의 절차로 남은 날짜와 일일 예산을 비교합니다.
- Simple: 일일 예산 guard가 없어 카드 요청이 계속 씁니다. 그달 안에 포함량을 넘을 것으로 보이면 Pro로 전환하거나, 신규 등록을 멈추도록 active 상한(`ACTIVE_USER_LIMIT`)을 현재 사용자 수로 낮춰 배포합니다.

## Pro 전환 조건과 비용 상한

다음 중 하나가 생기면 Pro 전환을 검토합니다.

- 그달 안에 Blob Advanced나 Simple이 포함량을 넘을 것으로 예상됨(이 경우 그달에 바로 전환)
- Blob 포함량 사용률이 80%를 넘는 달이 2개월 연속 생김
- 갱신 대기 때문에 신규 사용자가 Cron으로 진행되지 못하는 날이 반복됨(Cron이 `stopped: "blob-budget"`으로 끝나고 운영자 CLI `status`의 미발행 사용자 수가 줄지 않음)

비용 상한은 월 $20입니다. Pro는 월 $20에 같은 금액의 사용량 크레딧이 포함되고, Blob은 사용량 기반으로 과금됩니다. 전환하면 Spend Management로 크레딧을 넘는 on-demand 사용을 막고 "Pause Production Deployments"를 켭니다. 상한에 도달하면 Production이 일시 정지되어 카드 요청이 503을 받으므로, 정지 대신 알림만 받을지는 전환 시 다시 정합니다. Spend Management 금액이 크레딧을 포함하는지는 전환할 때 dashboard에서 확인합니다.

## 출시 확인

2026-11-12 UTC에 `main`(`09bf7bb`)의 Production deployment로 출시했습니다.

| 항목 | 결과 |
| --- | --- |
| `/healthz` | 200 JSON, `no-store` |
| 잘못된 사용자명 | 200 `invalid-username` 상태 SVG, 브라우저 `max-age=300` |
| 비정규 URL(대소문자, 기본 마스코트 query) | 정규 URL로 308 |
| 첫 요청 | 200 `pending`(`no-store`), bootstrap이 GitHub 14회·Blob Advanced 4회 뒤 `paused` |
| Preview | Deployment Protection으로 외부 요청 302. 그래서 Preview의 `unavailable` 응답은 직접 확인하지 못했고, Preview에 store·Secret이 없다는 것은 환경 변수 목록으로 확인했습니다 |
| 환경 변수 | `GH_STATS_TOKEN`·`CRON_SECRET`은 Production에만 있는 Sensitive 변수. store ID 두 개는 Production에만, store 연결이 만든 변수는 Production·Development에만 있음 |
| Cron | Production deployment에 `/api/cron` 등록. `vercel crons run /api/cron` 수동 실행이 `cron.completed`로 끝남. 2026-11-12 18시대(UTC) 예약 실행은 확인하지 못함(Hobby 로그 1시간 보존, 그 시각 일별 기록을 읽지 않음) |
| WAF | [구성](#구성)의 rule을 Log action으로 적용 |
| pilot 첫 발행 | 운영자 계정(최근 12개월 커밋 826개). 2026-11-13 수동 Cron 4회(11:15~11:47 UTC, GitHub 148·183·167·144회)째에 첫 발행. 두 카드 모두 200 `ready`, `image/svg+xml`, 브라우저 `max-age=300`, 반복 요청은 CDN HIT, XML 유효, `role="img"`·`<title>`·`<desc>` 있음 |
| Blob Advanced | `paused`로 끝난 Cron 실행(사용자 1명)은 회당 10회, 발행까지 끝난 실행은 16회(시작 목록 조회 포함). 그날 일별 합계 52회(예산 60회) |
