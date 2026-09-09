# GitHub Pixel Stats

GitHub Pixel Stats collects `limtjdghks`'s public GitHub activity and publishes two independent SVG cards for profile READMEs. The cards combine a pixel-style typeface and mascot with a soft grid layout, while the language card visualizes usage as segmented bars instead of raw totals.

The cards use the approved stepped pixel frames, a white cat in a dark hoodie, and dimensions of `570 × 300` and `355 × 300`. The stats footer shows real daily activity: one cell per UTC author date, seven rows per week, including zero-commit days. The first and last dates can be partial days because the rolling collection period has exact timestamps. Each cell includes its date and commit count, and `data.json` exposes the same values in `activity.days`.

## Published cards

The GitHub Pages deployment exposes these files:

- `stats.svg`: commits, owned public repositories, stars on owned non-fork repositories, and the pixel mascot
- `languages.svg`: the most committed languages shown as segmented bars
- `data.json`: the machine-readable snapshot used to render both cards
- `index.html`: a preview of the published cards

The snapshot covers the latest 12 months. Commit discovery is limited to public repositories and their default branches. A commit that touches one or more files of a language counts once for that language, so language totals can exceed the total number of unique commits.

## Repository setup

1. Create a public repository and add this project to its default branch.
2. Create a fine-grained personal access token for `limtjdghks`. Keep repository access read-only and do not grant write access. Fine-grained tokens include read-only access to public repositories, which lets the collector inspect public contributions across repository owners.
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

## Operations

- Scheduled workflows may be delayed during periods of high GitHub Actions load. The manual trigger is the recovery path when a scheduled run is delayed or dropped.
- GitHub automatically disables scheduled workflows in public repositories after 60 days without repository activity. Re-enable the workflow from the Actions tab and run it manually.
- Renew `GH_STATS_TOKEN` before it expires. An expired token fails collection without replacing the published cards.
- Treat `stats-state/state.json` as generated state and do not edit it manually.
- The internal next-state artifact is retained for one day and is not a long-term backup. The `stats-state` branch is the durable collector state.
- `data.json` and the state branch contain only data derived from public GitHub activity. Never add tokens, email addresses, or private repository data to generated output.

## Source data and font

Language metadata and representative colors come from GitHub Linguist 9.7.0. The pixel typeface is Pixelify Sans from Google Fonts. Their license texts are included in `third_party/`.
