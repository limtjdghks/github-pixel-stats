# HOST-12 CI·Secret 경계·action 업데이트

## PR CI

`.github/workflows/ci.yml`은 모든 `pull_request`와 `dev`·`main` push에서 실행됩니다. 외부 fork PR도 같은 검사를 받도록 Secret, Vercel 인증, 실제 네트워크 수집, 운영 Blob 없이 동작합니다.

| 순서 | 명령 | 확인 내용 |
| --- | --- | --- |
| 1 | `npm ci` | lockfile 그대로 설치 |
| 2 | `npm run typecheck` | 타입 검사 |
| 3 | `npm test` | fixture·fake 저장소 기반 전체 테스트 |
| 4 | `npm run build` | 타입 검사와 fixture 카드 출력 검증 |
| 5 | `npx --yes vercel@63.1.0 build --yes` | Function·정적 출력 생성(Preview 대상) |
| 6 | `npm run validate:vercel-output` | 아래 산출물 계약 검사 |

`vercel build`는 `.vercel/project.json`에 프로젝트 설정만 있으면 Vercel 계정 연결 없이 실행됩니다. CI는 빈 프로젝트 정보(`{"projectId":"ci","orgId":"ci","settings":{"framework":null}}`)를 만들고, 빌드 명령·출력 디렉터리·Function 설정은 `vercel.json`을 따릅니다. 이 빌드는 설치·`npm run build`를 다시 실행하므로 4단계와 일부 겹치지만, 실패 위치를 구분하려고 둘 다 둡니다.

### Vercel 산출물 검사

`npm run validate:vercel-output`은 `.vercel/output`을 `vercel.json`과 비교해 어긋난 항목을 모두 출력하고 실패합니다.

- `vercel.json`의 Function(`api/health`, `api/card`, `api/cron`)이 모두 생성됐는지
- 카드·Cron Function의 `filePathMap`에 `assets/fonts/NeoDunggeunmoPro.woff2`와 `data/languages.yml`이 있는지. 대상 Function(`FUNCTIONS_WITH_RUNTIME_FILES`)과 파일(`FUNCTION_RUNTIME_FILES`)은 `src/validation/vercel-output.ts`에서 정하므로, `vercel.json`에서 `includeFiles`가 빠져도 검사합니다.
- `.vercel/output/static/` 파일 목록이 `outputDirectory`(`public/`)와 정확히 같은지. 소스·fixture·데이터 파일이 공개 URL로 나가지 않게 합니다.
- 산출물의 Cron 설정이 `vercel.json`의 `crons`와 같은지

런타임에 읽는 파일이나 그 파일을 읽는 Function이 바뀌면 `vercel.json`의 `includeFiles`와 두 상수를 함께 고칩니다.

### 로컬 재현

연결된 Vercel 프로젝트가 없으면 CI와 같은 `.vercel/project.json`을 만든 뒤 실행합니다. `.vercel/`은 `.gitignore`에 있습니다.

```bash
npx --yes vercel@63.1.0 build --yes
npm run validate:vercel-output
```

## Secret 경계

| Workflow·배포 | 트리거 | Secret | 권한 |
| --- | --- | --- | --- |
| `ci.yml` | `pull_request`, `dev`·`main` push | 없음 | `contents: read`, checkout credential 미보존 |
| `refresh.yml`(legacy 개인 Pages) | 매일 `18:17 UTC` schedule, 수동 실행 | `GH_STATS_TOKEN`(collect job만) | job별 최소 권한 |
| Vercel 호스팅 배포 | Vercel Git 연동(HOST-13에서 연결) | Vercel 환경 변수(Production만 운영값) | Vercel이 관리 |

- `pull_request_target`·`workflow_run`처럼 fork 코드를 base 저장소 권한이나 Secret과 함께 실행하는 트리거는 쓰지 않습니다. GitHub는 fork에서 연 `pull_request`에 Secret을 넘기지 않고 `GITHUB_TOKEN`을 읽기 전용으로 줍니다.
- `refresh.yml`은 PR에서 실행되지 않습니다. fork에서는 schedule이 기본으로 비활성입니다.
- 운영 `GH_STATS_TOKEN`·`CRON_SECRET`·Blob store ID는 Vercel Production 환경에만 둡니다([`function-setup.md`](./function-setup.md)). fork PR의 Vercel Preview 배포 보호(Git Fork Protection) 설정 확인은 HOST-13 범위입니다.

## Action 고정과 업데이트 정책

- 모든 workflow의 `uses:`는 공식 저장소 release tag가 가리키는 full commit SHA로 고정하고 같은 줄에 `# vX.Y.Z` 주석을 둡니다. tag는 옮겨질 수 있지만 SHA는 바뀌지 않습니다.
- `.github/dependabot.yml`이 매주 github-actions 업데이트를 PR 하나로 묶어 올립니다. Dependabot은 기본 브랜치(`main`)의 설정만 읽으므로 `dev`가 `main`에 반영된 뒤부터 동작합니다.
- 업데이트 PR은 release note에서 권한·입력 변경을 확인하고 CI가 통과한 뒤 병합합니다. major 버전 변경은 `refresh.yml`의 Pages 배포 영향까지 확인합니다.
- 직접 고칠 때는 `gh api repos/{owner}/{repo}/commits/{tag} -q .sha`로 SHA를 확인합니다. fork 네트워크의 commit을 쓰지 않도록 공식 저장소에서 조회합니다.
- `vercel@63.1.0`은 workflow의 `npx` 인자라 Dependabot이 올리지 않습니다. 배포 전 단계(HOST-13)나 Vercel 빌드 동작 변경이 필요할 때 로컬에서 위 재현 절차로 확인한 뒤 수동으로 올립니다.
- `npx`는 vercel CLI의 최상위 버전만 고정하고 하위 의존성은 실행할 때마다 다시 해석합니다. 따라서 코드 변경이 없어도 하위 의존성의 새 release 때문에 CI 결과가 달라질 수 있습니다. 소스 변경 없이 `vercel build` 단계만 실패하면 이 원인을 먼저 의심하고, 직전에 통과한 실행과 CLI 출력을 비교합니다.
