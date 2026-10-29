# HOST-13 ① staging 검증

운영 프로젝트와 분리한 staging에 `dev` 기반 브랜치를 배포해 실제 Vercel에서만 확인할 수 있는 동작을 검증한 기록입니다. 결정과 경위는 Issue #32에 있습니다.

## 구성

| 항목 | 값 |
| --- | --- |
| Vercel 프로젝트 | `github-pixel-stats-staging`(Hobby, Git 연동 없음). 이 프로젝트의 Production이 staging입니다 |
| URL | `https://github-pixel-stats-staging.vercel.app` |
| Blob store | `gps-staging-private`(private), `gps-staging-public`(public). 둘 다 `iad1`, production·development 환경에 연결 |
| 환경 변수(Production) | `BLOB_PRIVATE_STORE_ID`·`BLOB_PUBLIC_STORE_ID`·`VERCEL_BLOB_RETRIES=3`(일반), `GH_STATS_TOKEN`·`CRON_SECRET`(Sensitive, 운영자가 직접 입력) |

운영 프로젝트 `github-pixel-stats-hosted`와 store·Secret을 공유하지 않습니다. Blob 포함량은 계정 단위라 staging 사용량도 같은 Hobby 포함량을 씁니다.

### 설정에서 알게 된 것

- store를 프로젝트에 연결하면 `BLOB_READ_WRITE_TOKEN`이 자동으로 생깁니다. 두 번째 store는 같은 이름과 충돌하므로 다른 접두사(`PUBLIC_BLOB`)로 연결해야 합니다. 코드는 이 token을 쓰지 않습니다.
- store ID를 Sensitive로 저장하면 `vercel env pull`이 `[SENSITIVE]`만 받아 운영자 CLI가 실패합니다. Secret이 아니므로 일반 변수로 둡니다.
- 운영자 CLI의 로컬 OIDC token은 development 환경용이라 store를 development 환경에도 연결해야 합니다([`recovery.md`](./recovery.md)).
- Hobby의 runtime log 보존은 1시간입니다. 지난 실행은 일별 사용량 기록(`npm run ops usage`)으로 확인합니다.

## 배포

로컬에서 Production 빌드와 산출물 검사를 한 뒤 빌드 결과만 올립니다. 소스 전체를 올리지 않아 `.env*` 같은 로컬 파일이 배포에 섞이지 않습니다.

```bash
npx vercel@63.1.0 pull --yes --environment production
npx vercel@63.1.0 build --prod
npm run validate:vercel-output
npx vercel@63.1.0 deploy --prebuilt --prod
```

Cron은 `npx vercel@63.1.0 crons run /api/cron`으로 즉시 실행할 수 있습니다. Vercel이 `CRON_SECRET`을 붙여 호출하므로 운영자가 Secret 값을 다루지 않습니다.

## 확인 결과

| 항목 | 결과 |
| --- | --- |
| `/healthz` | 200 JSON, `no-store` |
| 잘못된 사용자명 | 200 `invalid-username` 상태 SVG, CDN HIT |
| 비정규 URL(대소문자, 미등록·기본 마스코트) | 정규 URL로 308 한 번, CDN HIT |
| 첫 요청 | 200 `pending`(`no-store`, CDN MISS), `waitUntil` bootstrap이 GitHub 20회 뒤 `paused` |
| 존재하지 않는 계정 | 404로 `failed`, 상태 SVG가 CDN HIT로 cache돼 반복 요청이 Function·GitHub에 닿지 않음 |
| `no-store`와 `Vercel-CDN-Cache-Control` | 브라우저에는 `no-store`, CDN은 HIT. `Vercel-CDN-Cache-Control`은 응답에서 빠짐 |
| HEAD | GET과 같은 상태·헤더 |
| 예약 Cron 전달 | 2026-10-23 UTC 일별 기록 `cron.runs: 1` |
| Blob 일일 예산 | bootstrap 몫(26)이 차면 `bootstrap.skipped`(`blob-budget`) |
| Secret 노출 | 응답 본문·SVG·앱 로그에 token, store ID, 사용자명, Blob pathname 없음 |
| 운영자 CLI `status`·`usage` | 로컬 OIDC로 동작(development 연결 후) |
| 첫 발행·재발행 | 커밋 716개 계정이 2026-10-25 예약 Cron에서 첫 발행, 10-26 예약 Cron에서 20시간 갱신으로 재발행(이미 받은 커밋은 cache, GitHub 48회) |
| 마지막 성공 보존 | manifest에 current·previous·retired(1시간 유예) release가 남음 |
| 발행 카드 | 200 `ready`, `image/svg+xml`, 브라우저 `max-age=300`, 반복 요청은 CDN HIT. XML 유효, `role="img"`·`<title>`·`<desc>` 있음 |
| 마스코트 variant | 등록된 마스코트가 기본 `cat` 하나라 기본 외 variant는 staging에서 확인할 대상이 없음. 기본·미등록 `mascot` query는 정규 URL로 308 |
| rollback | `ops rollback --yes`로 previous를 current로 승격. CDN cache 때문에 안정 URL은 그대로였고, `vercel cache purge --type cdn` 약 6초 뒤 바뀜. rollback이 manifest를 바꾸므로 다음 갱신은 그로부터 20시간 뒤로 밀리며, 1.5시간 뒤 예약 Cron은 이 사용자를 처리하지 않음([`recovery.md`](./recovery.md#rollback)의 설계대로) |
| 삭제·복구 | 미발행 실패 사용자를 `ops delete --yes`로 지우자 purge 1초 뒤 `removed` 상태 SVG(CDN HIT, 브라우저 `no-store`). `ops restore`로 등록 항목이 지워짐. 복구 뒤에도 CDN의 `removed` 카드는 purge해야 바뀜 |
| rollback 뒤 재발행 | manifest 교체 20시간 뒤 첫 예약 Cron(2026-10-28 UTC)에서 새 수집으로 재발행 |
| 발행 사용자 삭제 | `ops delete --yes`가 private 6개(manifest·checkpoint·release)와 public 카드 4개를 지움. purge 직후 카드 URL은 `removed`. 지운 카드의 Blob 직접 URL은 135초 뒤까지 일부 edge에서 200을 돌려줌(측정 위치 한 곳, 30초 간격). query를 붙여 cache를 우회한 요청은 103초 전에 모두 응답을 멈춤 |
| 발행 사용자 복구 | `ops restore` 후 purge 1초 뒤 `pending`으로 돌아와 신규 사용자로 다시 수집 |

## 발견한 결함과 수정

| 결함 | 원인 | 수정 |
| --- | --- | --- |
| 정규 카드 URL이 자기 자신으로 계속 308 | Vercel rewrite는 Function에 원래 공개 경로를 넘기고 source 경로 파라미터(`username`)를 query로 한 번 더 붙임. 이를 사용자 query로 판정 | source 파라미터를 내부 이름 `:__username`으로 변경([`card-route.md`](./card-route.md)) |
| 조직 저장소 커밋 하나의 403으로 사용자 전체 `failed` | 조직이 유효기간 366일 초과 fine-grained token을 금지. 상세 조회 403을 사용자 실패로 처리 | 커밋 상세의 rate limit이 아닌 403·404·451은 그 커밋만 언어 없이 저장([`refresh.md`](./refresh.md)). token은 90일 만료로 재발급 |
| 두 번째 batch부터 매번 `conflict`, 수집을 이어 가지 못함 | Blob이 1KB 이상 객체의 `get()` ETag를 weak(`W/"…"`)로 내려주며 그 값으로는 `ifMatch`가 항상 실패 | adapter가 읽을 때 strong ETag로 정규화([`blob-storage.md`](./blob-storage.md)) |

## 실측값

| 항목 | 값 |
| --- | --- |
| bootstrap 1회 | GitHub 20회, Blob Advanced 1~4회(추정치 `JOB_ADVANCED_ESTIMATE` 12) |
| Cron 사용자당 60초 | GitHub 170~196회(초당 약 3회) |
| Cron 1회(사용자 2명) | Blob Advanced 12회(사용량·등록 기록 포함) |
| 커밋 716개 계정 | 요청 약 720회. bootstrap 1회 + Cron 약 4회 |

Hobby의 하루 1회 Cron으로는 커밋 수백 개 사용자의 첫 카드까지 수일이 걸립니다. 실제로 이 계정은 첫 요청(10-23) 뒤 결함 수정·token 교체를 거쳐 10-25에 첫 발행됐습니다.

서비스 일별 기록의 Blob Advanced 합계는 10-23~10-26 동안 118회입니다. Hobby 팀은 `vercel usage`로 사용량을 조회할 수 없어(`Billing cost data is unavailable`) Vercel 대시보드 값과 비교해야 하며, 대시보드 값은 운영자 CLI·진단 작업이 더해져 더 큽니다.

## 운영 절차에 반영할 것

- public 카드 Blob은 브라우저 cache 1년(`max-age=31536000`)으로 제공됩니다. 카드 route는 Blob URL을 노출하지 않지만, 누군가 Blob URL을 직접 받아 두었다면 그 브라우저 사본은 삭제 뒤에도 남습니다. 삭제 요청 안내의 반영 시간에는 CDN purge와 Blob edge 잔존(측정 약 2분)을 함께 고려합니다.
- `vercel deploy --prebuilt --prod`의 첫 시도가 출력 없이 끝나거나 `Not authorized`로 실패한 적이 두 번 있었고, 다시 실행하면 성공했습니다. 배포 뒤에는 `vercel ls --prod`로 새 deployment를 확인합니다.

- rollback·삭제·복구 뒤에는 CDN cache를 비워야 안정 URL에 반영됩니다. 지금은 프로젝트 전체를 purge하므로 다른 사용자 카드도 다음 요청에서 다시 읽습니다. 사용자 단위 무효화(cache tag)는 Issue #33 후보입니다.
- GitHub token이 무효(401)이면 사용자 프로필 조회부터 실패해 사용자가 `failed`로 표시됩니다. 운영자 실수가 사용자 실패로 기록되므로 token 교체 직후 `status`의 `failed` 목록을 확인합니다. 상한·추정치 조정 후보는 Issue #33에 있습니다.
