# Contributing to GitHub Pixel Stats

Thanks for your interest in improving GitHub Pixel Stats! Bug reports, ideas, documentation fixes, code and new mascots are all welcome.

You do not need a fork to use the cards. Fork this repository only when you want to change the project and send a pull request.

## Reporting issues

Open an issue with:

- the card URL you used (or the username, if you are comfortable sharing it);
- what you expected and what you saw, ideally with a screenshot;
- the message on the card, if it shows one instead of stats.

Do not post tokens or anything private. To have your data removed, follow [PRIVACY.md](PRIVACY.md#removing-your-data) instead of opening an issue.

## Development setup

You need Node.js 24.

```bash
npm ci
npm run typecheck
npm test
npm run build
```

- `npm test` runs every test against fixtures and in-memory fakes, so it needs no token, network access or storage.
- `npm run build` type-checks the project, renders the fixture cards to `build/fixtures/`, and validates them. Open `build/fixtures/<name>/index.html` to preview the cards in a browser.

### Collecting real data locally (optional)

To render cards from a real account, create a GitHub token with read-only access to public repositories and run:

```bash
GH_STATS_TOKEN=<token> npm run generate -- --username <username> --state .state/<username>/state.json --next-state build/<username>/next-state.json --out dist/<username>
npm run validate:output -- --username <username> --state build/<username>/next-state.json --out dist/<username>
```

Never commit tokens or generated state.

## Pull requests

1. Create a branch from `dev`.
2. Keep each pull request focused on one change, and add or update tests when behavior changes.
3. Run `npm run typecheck`, `npm test` and `npm run build` before pushing.
4. Open the pull request against `dev` and fill in the template.

CI runs the same checks plus a local `vercel build` and an output check, all without secrets, so pull requests from forks are verified the same way. See [docs/hosting/ci.md](docs/hosting/ci.md) for details.

## Adding a mascot

A mascot is a static SVG renderer drawn in the stats card's `94 × 94` slot.

1. Write a renderer with the `MascotRenderer` signature `(x, y) => string` that draws inside the slot at that position. Use plain SVG shapes only: no external images, fonts, links or scripts. The built-in cat in `src/render/mascot.ts` is a good starting point.
2. Register it under a short lowercase ID in `src/render/mascot-registry.ts`. The `MascotId` type and the accepted `?mascot=` values update automatically from the registry keys.
3. Update the storage budget. Every publish renders and stores one stats card per registered mascot, so each new mascot adds one storage write per user on every update. Raise `JOB_ADVANCED_ESTIMATE` in `src/hosting/usage-policy.ts` by one per added mascot, and mention the change in the pull request.
4. Record the author, source, license and the basis for using it in the hosted service in [third_party/README.md](third_party/README.md). Only add artwork you have the right to publish under these terms.
5. Run `npm test`. The publish tests render and validate every registered mascot.
6. Preview the card. `npm run build` renders the fixture cards with the default mascot only, so temporarily set `DEFAULT_MASCOT_ID` to your ID, run `npm run build`, open `build/fixtures/<name>/index.html`, and then set it back.
7. Add the new ID to the mascot table in the README.

The preview images in `docs/images/` are rendered with the current card code. If you change the card design, re-render them so the README matches.

## Project layout

| Path | Contents |
| --- | --- |
| `api/` | Vercel Functions: card responses, the scheduled refresh and the health check |
| `src/data/` | GitHub collection, checkpoints and language classification |
| `src/render/` | SVG card, status card and mascot renderers |
| `src/hosting/` | Request handling, admission limits, refresh jobs and operations |
| `src/storage/` | Blob storage adapters and the published-card manifest |
| `src/validation/` | Output and build checks |
| `test/` | Tests and fixtures |
| `docs/hosting/` | Hosting design, contracts and operations runbooks (Korean) |

## License

By contributing, you agree that your contributions are licensed under the project's [MIT License](LICENSE).
