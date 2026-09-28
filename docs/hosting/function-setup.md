# HOST-05 Function 설정

현재 호스팅 진입점은 골격입니다. `GET /healthz`는 외부 요청 없이 200 JSON을 반환하고, `/{username}/stats.svg`, `/{username}/languages.svg`, `/api/cron`은 501 JSON을 반환합니다. 카드 수집과 Cron 실행은 후속 작업에서 연결합니다.

## 빌드

- `npm run build`: Secret 없이 타입 검사와 fixture 출력 검증을 실행합니다.
- `npm run build:cards`: 기존 개인용 카드 수집·검증 명령이며 `GH_STATS_TOKEN`과 사용자명이 필요합니다.
- `vercel build`: 연결된 Vercel 프로젝트의 Preview 설정으로 Function 산출물을 로컬 생성합니다. 각 `.func/.vc-config.json`의 `filePathMap`에서 카드의 `assets/fonts/NeoDunggeunmoPro.woff2`, Cron의 `data/languages.yml` 연결과 원본 파일 존재 여부를 확인합니다.
- Vercel의 정적 출력은 `public/`만 사용합니다. `.vercel/output/static/`에 소스, fixture, `data/languages.yml`이 없는지도 확인합니다.

## 환경

| Vercel 환경 | `VERCEL_ENV` | 현재 필요한 Secret |
| --- | --- | --- |
| Production | `production` | 없음 |
| Preview | `preview` | 없음 |
| Development | `development` 또는 로컬 실행 시 미설정 | 없음 |

Function 시작 시 `VERCEL_ENV`와 선택적 `GH_STATS_TOKEN`, `BLOB_READ_WRITE_TOKEN`, `CRON_SECRET`의 빈 값 여부를 검증합니다. 현재 Function은 이 Secret을 사용하지 않습니다. 운영 GitHub token과 Blob 쓰기 권한을 Preview에 등록하지 마세요. 프로젝트의 환경별 Secret 설정과 실제 수집 연결은 후속 작업에서 진행합니다.
