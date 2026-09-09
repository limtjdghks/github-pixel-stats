import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CollectionFailure, collectStats } from "../data/collect.js";
import { USERNAME } from "../model.js";
import { renderLanguagesCard, renderPreviewHtml, renderStatsCard } from "../render/index.js";
import { parseFileOptions } from "./options.js";

async function main(): Promise<void> {
  const options = parseFileOptions(process.argv.slice(2));
  const token = process.env.GH_STATS_TOKEN?.trim();
  if (!token) {
    throw new Error("GH_STATS_TOKEN is required.");
  }
  const requestedUsername = process.env.GITHUB_USERNAME?.trim() || USERNAME;
  if (requestedUsername !== USERNAME) {
    throw new Error(`This service is configured for ${USERNAME}.`);
  }

  const result = await collectStats({ token, statePath: options.statePath });
  const statsSvg = renderStatsCard(result.snapshot);
  const languagesSvg = renderLanguagesCard(result.snapshot);
  const preview = renderPreviewHtml(statsSvg, languagesSvg);

  await Promise.all([
    mkdir(options.outputPath, { recursive: true }),
    mkdir(dirname(options.nextStatePath), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(options.outputPath, "stats.svg"), statsSvg),
    writeFile(join(options.outputPath, "languages.svg"), languagesSvg),
    writeFile(join(options.outputPath, "data.json"), `${JSON.stringify(result.snapshot, null, 2)}\n`),
    writeFile(join(options.outputPath, "index.html"), preview),
    writeFile(options.nextStatePath, `${JSON.stringify(result.nextState, null, 2)}\n`),
  ]);

  console.log(JSON.stringify(result.metrics));
}

main().catch((error: unknown) => {
  if (error instanceof CollectionFailure) {
    console.error(JSON.stringify(error.metrics));
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
