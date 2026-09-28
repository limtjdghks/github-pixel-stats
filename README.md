# GitHub Pixel Stats

GitHub Pixel Stats collects a selected GitHub user's public activity and publishes two independent SVG cards for profile READMEs. The cards combine a pixel-style typeface and mascot with a soft grid layout, while the language card visualizes usage as segmented bars instead of raw totals.

The cards use the approved stepped pixel frames, a white cat in a dark hoodie, and dimensions of `570 × 300` and `355 × 300`. The stats footer shows real daily activity: one cell per UTC author date, seven rows per week, including zero-commit days. The first and last dates can be partial days because the rolling collection period has exact timestamps. Each cell includes its date and commit count, and `data.json` exposes the same values in `activity.days`.

## Published cards

The GitHub Pages deployment exposes these files:

- `stats.svg`: commits, owned public repositories, stars on owned non-fork repositories, and the pixel mascot
- `languages.svg`: the most committed languages shown as 10-segment bars
- `data.json`: the machine-readable snapshot used to render both cards
- `index.html`: a preview of the published cards

The snapshot covers the latest 12 months. Commit discovery is limited to public repositories and their default branches. A commit that touches one or more files of a language counts once for that language, so language totals can exceed the total number of unique commits. Each language share uses the sum of commit counts across **all** classified languages as its denominator, while only the top five languages are displayed. Bars show `round(share × 10)` filled cells with a minimum of one for a nonzero language. One cell is therefore a minimum visibility marker for shares below 10%, not an exact percentage.

## Repository setup

1. Create a public repository and add this project to its default branch.
2. Create a fine-grained personal access token that can read public repositories for the selected user. Keep repository access read-only and do not grant write access. Fine-grained tokens include read-only access to public repositories, which lets the collector inspect public contributions across repository owners.
3. Save the token as a repository Actions secret named `GH_STATS_TOKEN` under **Settings → Secrets and variables → Actions**.
4. Open **Settings → Pages** and select **GitHub Actions** as the build and deployment source.
5. Run **Refresh GitHub pixel stats** once from the **Actions** tab to create the first deployment and bootstrap the `stats-state` branch.

The token is used only by the collection job. GitHub Pages deployment uses the short-lived repository `GITHUB_TOKEN` with only `pages: write` and `id-token: write` permissions.

## Refresh workflow

The workflow runs every day at `18:17 UTC` (`03:17 Asia/Seoul`) and can also be started with **Run workflow** from the Actions tab. Only one refresh runs at a time, and an active Pages deployment is never canceled by a newer run.

The jobs run in this order:

1. `collect` restores `state.json` when the `stats-state` branch exists, installs dependencies with Node.js 24, type-checks the project, generates the snapshot and SVGs, validates all output, and uploads the deployment artifacts.
2. `persist-state` updates `stats-state/state.json` after collection succeeds. It creates the branch as an orphan on the first successful run and commits only when the state has changed.
3. `deploy` publishes the validated `dist` directory to the `github-pages` environment after the state is safely persisted.

If `stats-state` exists without `state.json`, collection fails instead of silently rebuilding from an invalid cache. If collection, generation, or validation fails, deployment is skipped and the previous successful Pages output remains active.

## 사용자명 설정과 여러 사용자 실행

생성·검증 CLI는 `--username`을 먼저 사용하고, 인자가 없으면 환경 변수 `GITHUB_USERNAME`을 사용합니다. 두 값 모두 없거나 비어 있거나 GitHub 사용자명 형식에 맞지 않으면 오류가 발생합니다. 입력 양끝의 공백은 제거하며 사용자명 비교에서는 대소문자를 구분하지 않습니다. 카드와 저장 데이터에는 GitHub API가 반환한 `login` 표기를 사용합니다. 수집에는 `GH_STATS_TOKEN`도 필요합니다.

```bash
npm run generate -- --username octocat --state .state/octocat/state.json --next-state build/octocat/next-state.json --out dist/octocat
npm run validate:output -- --username octocat --state build/octocat/next-state.json --out dist/octocat
```

여러 사용자를 수집할 때는 예시처럼 사용자별로 입력 state, 다음 state, 출력 디렉터리를 분리하세요. state·snapshot의 schema v1은 유지되며 기존 동일 사용자 캐시를 재사용할 수 있습니다. 다른 사용자의 캐시는 재사용하지 않고 새로 수집합니다. 기존 `stats-state/state.json`을 사용하는 개인 Pages 작업은 같은 사용자라면 그대로 이어서 사용할 수 있습니다.

Pages 워크플로는 Actions 저장소 변수 `GITHUB_USERNAME`이 있으면 그 값을 사용하고, 없으면 `github.repository_owner`를 사용합니다. **Settings → Secrets and variables → Actions → Variables**에서 변수를 설정할 수 있습니다. 생성과 검증 단계는 동일한 사용자명을 사용합니다. 저장소 소유자가 아닌 사용자의 카드를 게시하려면 변수와 읽기 권한이 있는 `GH_STATS_TOKEN`을 함께 설정하세요.

## Add the cards to a profile README

Replace `github-pixel-stats` if the service repository uses a different name.

```html
<img
  src="https://limtjdghks.github.io/github-pixel-stats/stats.svg"
  width="570"
  alt="limtjdghks GitHub activity"
/>
```

The language card is a separate image and can be placed independently.

```html
<img
  src="https://limtjdghks.github.io/github-pixel-stats/languages.svg"
  width="355"
  alt="limtjdghks most committed languages"
/>
```

To place both cards on one row, wrap the two images in the same paragraph and keep their widths at `570` and `355`.

## 마스코트 preset 추가

`stats.svg`의 기본 마스코트 ID는 `cat`이며, 현재 등록된 preset도 기존 고양이 하나입니다. 마스코트는 카드의 `94 × 94` 슬롯에 그리는 정적 SVG renderer입니다. 새 preset을 추가하려면 해당 renderer를 작성하고 `src/render/mascot-registry.ts`의 registry에 ID와 renderer를 등록하세요. `MascotId`는 registry 키에서 생성되므로 ID 목록을 별도로 수정할 필요가 없습니다. `resolveMascotId()`는 등록된 ID의 정확한 일치만 허용하고 그 외의 값은 `cat`으로 되돌립니다.

등록 전에 제작자, 원본 출처 URL 또는 파일, 라이선스, 서비스와 저장소에서 사용할 권리나 허가 근거를 README 또는 `third_party/`에 기록하세요. 외부 리소스를 참조하지 않는 SVG인지 확인하고 fixture build와 출력 검증을 실행하세요. `languages.svg`에는 마스코트를 적용하지 않습니다. URL의 `mascot` query 연결은 호스팅 카드 endpoint 작업에서 진행합니다.

## Operations

- Scheduled workflows may be delayed during periods of high GitHub Actions load. The manual trigger is the recovery path when a scheduled run is delayed or dropped.
- GitHub automatically disables scheduled workflows in public repositories after 60 days without repository activity. Re-enable the workflow from the Actions tab and run it manually.
- Renew `GH_STATS_TOKEN` before it expires. An expired token fails collection without replacing the published cards.
- Treat `stats-state/state.json` as generated state and do not edit it manually.
- The internal next-state artifact is retained for one day and is not a long-term backup. The `stats-state` branch is the durable collector state.
- `data.json` and the state branch contain only data derived from public GitHub activity. Never add tokens, email addresses, or private repository data to generated output.

## Source data and font

Language metadata and representative colors come from GitHub Linguist 9.7.0. The embedded pixel typeface is [NeoDunggeunmo Pro](https://github.com/neodgm/neodgm-pro-webfont), pinned to webfont-kit commit `1751c2981808869750c7df391c1d2b486e978f12`. Their license texts are included in `third_party/`.
