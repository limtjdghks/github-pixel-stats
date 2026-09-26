import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { LinguistClassifier } from "../data/linguist.js";
import { renderLanguagesCard, renderPreviewHtml, renderStatsCard } from "../render/index.js";
import { validateGeneratedOutput } from "../validation/output.js";
import { loadUserFixture, USER_FIXTURE_NAMES } from "../../test/helpers/load-user-fixture.js";

async function main(): Promise<void> {
  const classifier = await LinguistClassifier.loadDefault();
  const fixtureRoot = resolve("build/fixtures");

  for (const name of USER_FIXTURE_NAMES) {
    const fixture = await loadUserFixture(name);
    const statsSvg = renderStatsCard(fixture.snapshot);
    const languagesSvg = renderLanguagesCard(fixture.snapshot);
    const preview = renderPreviewHtml(statsSvg, languagesSvg);
    validateGeneratedOutput({
      expectedUsername: fixture.githubResponses.username,
      snapshot: fixture.snapshot,
      state: fixture.state,
      statsSvg,
      languagesSvg,
      preview,
      classifier,
    });

    const outputPath = join(fixtureRoot, name);
    await mkdir(outputPath, { recursive: true });
    await Promise.all([
      writeFile(join(outputPath, "stats.svg"), statsSvg),
      writeFile(join(outputPath, "languages.svg"), languagesSvg),
      writeFile(join(outputPath, "data.json"), `${JSON.stringify(fixture.snapshot, null, 2)}\n`),
      writeFile(join(outputPath, "index.html"), preview),
      writeFile(join(outputPath, "state.json"), `${JSON.stringify(fixture.state, null, 2)}\n`),
    ]);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
