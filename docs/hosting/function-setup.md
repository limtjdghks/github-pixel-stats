# HOST-05 Function 설정

`GET /healthz`는 외부 요청 없이 200 JSON을 반환합니다. `/{username}/stats.svg`, `/{username}/languages.svg`는 발행된 카드나 상태 SVG를 반환하며 계약은 [`card-route.md`](./card-route.md)에 있습니다. `/api/cron`은 하루 1회 Vercel Cron이 호출하는 갱신 endpoint이며, bootstrap과 함께 계약은 [`refresh.md`](./refresh.md)에 있습니다.

## 빌드

- `npm run build`: Secret 없이 타입 검사와 fixture 출력 검증을 실행합니다.
- `npm run build:cards`: 기존 개인용 카드 수집·검증 명령이며 `GH_STATS_TOKEN`과 사용자명이 필요합니다.
- `vercel build`: 연결된 Vercel 프로젝트의 Preview 설정으로 Function 산출물을 로컬 생성합니다. 각 `.func/.vc-config.json`의 `filePathMap`에서 카드와 Cron Function 모두에 `assets/fonts/NeoDunggeunmoPro.woff2`와 `data/languages.yml`이 연결됐는지, 원본 파일이 있는지 확인합니다.
- Vercel의 정적 출력은 `public/`만 사용합니다. `.vercel/output/static/`에 소스, fixture, `data/languages.yml`이 없는지도 확인합니다.
- `npm run validate:vercel-output`: 위 두 확인과 Function 생성·Cron 설정을 `vercel.json`과 비교해 자동 검사합니다. PR CI가 Vercel 인증 없이 `vercel build` 뒤 실행하며 절차는 [`ci.md`](./ci.md)에 있습니다.

## 환경

| Vercel 환경 | `VERCEL_ENV` | 수집·갱신에 필요한 Secret |
| --- | --- | --- |
| Production | `production` | `GH_STATS_TOKEN`, `CRON_SECRET` |
| Preview | `preview` | 없음(설정하지 않으면 bootstrap과 Cron이 실행되지 않음) |
| Development | `development` 또는 로컬 실행 시 미설정 | 없음 |

Function 시작 시 `VERCEL_ENV`와 선택적 `GH_STATS_TOKEN`, `CRON_SECRET`, `BLOB_PRIVATE_STORE_ID`, `BLOB_PUBLIC_STORE_ID`의 빈 값 여부를 검증합니다. 카드 Function은 두 Blob store ID로 카드를 읽고, `GH_STATS_TOKEN`까지 있으면 pending 요청에서 bootstrap을 실행합니다. 두 store ID가 모두 없으면 형식이 올바른 카드 요청에 `unavailable` 상태 SVG를 반환합니다. 응답 분기 전체는 [`card-route.md`](./card-route.md)에 있습니다. Cron Function은 `CRON_SECRET`, `GH_STATS_TOKEN`, 두 Blob store ID가 모두 있어야 실행되고, 하나라도 없으면 503입니다([`refresh.md`](./refresh.md)). 운영 GitHub token과 운영 Blob store ID를 Preview에 등록하지 마세요. 프로젝트의 환경별 Secret 실제 설정은 HOST-13에서 진행합니다.

## Blob 저장소

GPS-HOST-06의 저장 계약은 [`blob-storage.md`](./blob-storage.md)에 정리합니다. Blob 인증은 장기 `BLOB_READ_WRITE_TOKEN` 대신 Vercel OIDC token과 store ID를 사용합니다. 두 store ID는 함께 설정해야 하며 같은 값이면 시작 시 오류로 처리합니다.
