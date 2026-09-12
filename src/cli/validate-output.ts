import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { LinguistClassifier } from "../data/linguist.js";
import { loadState } from "../data/state.js";
import { validateGeneratedOutput } from "../validation/output.js";
import { parseFileOptions } from "./options.js";

async function main(): Promise<void> {
  const options = parseFileOptions(process.argv.slice(2));
  const [dataSource, statsSvg, languagesSvg, preview, loadedState, classifier] = await Promise.all([
    readFile(join(options.outputPath, "data.json"), "utf8"),
    readFile(join(options.outputPath, "stats.svg"), "utf8"),
    readFile(join(options.outputPath, "languages.svg"), "utf8"),
    readFile(join(options.outputPath, "index.html"), "utf8"),
    loadState(options.statePath),
    LinguistClassifier.loadDefault(),
  ]);
  const snapshot = JSON.parse(dataSource) as unknown;
  if (!loadedState.cacheUsable || !loadedState.state) {
    throw new Error("The next collector state is missing or incompatible.");
  }
  validateGeneratedOutput({
    snapshot,
    state: loadedState.state,
    statsSvg,
    languagesSvg,
    preview,
    classifier,
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
