import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { XMLValidator } from "fast-xml-parser";
import { LANGUAGE_BAR_SEGMENTS, LANGUAGES_CARD, STATS_CARD } from "../config.js";
import { LinguistClassifier } from "../data/linguist.js";
import { loadState } from "../data/state.js";
import type { CachedCommit, CollectorState, LanguageStat, StatsSnapshot } from "../model.js";
import { SNAPSHOT_SCHEMA_VERSION, USERNAME } from "../model.js";
import { parseFileOptions } from "./options.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertLanguage(value: unknown, index: number): asserts value is LanguageStat {
  assert(isRecord(value), `Language ${index} is not an object.`);
  assert(typeof value.name === "string" && value.name.length > 0, `Language ${index} has no name.`);
  assert(Number.isInteger(value.commitCount) && Number(value.commitCount) > 0, `Language ${index} has an invalid count.`);
  assert(typeof value.share === "number" && value.share > 0 && value.share <= 1, `Language ${index} has an invalid share.`);
  assert(
    Number.isInteger(value.filledSegments) && Number(value.filledSegments) >= 1 && Number(value.filledSegments) <= LANGUAGE_BAR_SEGMENTS,
    `Language ${index} has an invalid segment count.`,
  );
  assert(typeof value.color === "string" && /^#[\dA-Fa-f]{6}$/.test(value.color), `Language ${index} has an invalid color.`);
}

function assertSnapshot(value: unknown): asserts value is StatsSnapshot {
  assert(isRecord(value), "data.json is not an object.");
  assert(value.schemaVersion === SNAPSHOT_SCHEMA_VERSION, "data.json has an unsupported schema version.");
  assert(value.username === USERNAME, "data.json has an unexpected username.");
  assert(typeof value.generatedAt === "string" && !Number.isNaN(Date.parse(value.generatedAt)), "data.json has an invalid generatedAt.");
  assert(isRecord(value.period), "data.json has no period.");
  assert(
    typeof value.period.from === "string" &&
      typeof value.period.to === "string" &&
      !Number.isNaN(Date.parse(value.period.from)) &&
      !Number.isNaN(Date.parse(value.period.to)) &&
      Date.parse(value.period.from) <= Date.parse(value.period.to),
    "data.json has an invalid period.",
  );
  assert(value.period.label === "Last 12 months", "data.json has an unexpected period label.");
  assert(isRecord(value.stats), "data.json has no stats.");
  for (const key of ["commits", "publicRepositories", "stars"] as const) {
    assert(Number.isInteger(value.stats[key]) && Number(value.stats[key]) >= 0, `data.json has an invalid ${key}.`);
  }
  assert(Array.isArray(value.languages) && value.languages.length <= 5, "data.json has an invalid language list.");
  value.languages.forEach(assertLanguage);
  assert(isRecord(value.source), "data.json has no source metadata.");
  assert(value.source.commitScope === "public-default-branches", "data.json has an invalid commit scope.");
  assert(value.source.languageMetric === "commits-touching-language", "data.json has an invalid language metric.");
}

function aggregateState(state: CollectorState): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const commit of Object.values(state.commits) as CachedCommit[]) {
    for (const language of new Set(commit.languages)) {
      counts.set(language, (counts.get(language) ?? 0) + 1);
    }
  }
  return [...counts].sort(([leftName, leftCount], [rightName, rightCount]) =>
    rightCount - leftCount || leftName.localeCompare(rightName),
  ).slice(0, 5);
}

function assertSvg(svg: string, name: string, width: number, height: number): void {
  const xmlResult = XMLValidator.validate(svg);
  assert(xmlResult === true, `${name} is not valid XML.`);
  assert(svg.includes(`width="${width}" height="${height}"`), `${name} has an unexpected size.`);
  assert(svg.includes(`viewBox="0 0 ${width} ${height}"`), `${name} has an unexpected viewBox.`);
  assert(svg.includes("role=\"img\""), `${name} has no image role.`);
  assert(svg.includes("aria-labelledby="), `${name} has no accessible label relationship.`);
  assert(/<title\s+id="[^"]+">.+<\/title>/.test(svg), `${name} has no title.`);
  assert(/<desc\s+id="[^"]+">.+<\/desc>/.test(svg), `${name} has no description.`);
  assert(svg.includes("shape-rendering=\"crispEdges\""), `${name} does not use crisp pixel rendering.`);
  assert(svg.includes("data:font/woff2;base64,"), `${name} does not embed Pixelify Sans.`);
  assert(!/<script\b/i.test(svg), `${name} contains a script.`);
  assert(!/<foreignObject\b/i.test(svg), `${name} contains foreignObject.`);
  const withoutNamespace = svg.replace('xmlns="http://www.w3.org/2000/svg"', "");
  assert(!/https?:\/\//i.test(withoutNamespace), `${name} contains an external URL.`);
  assert(!/(?:href|src)=["']\/\//i.test(withoutNamespace), `${name} contains a protocol-relative URL.`);
}

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
  assertSnapshot(snapshot);
  assert(loadedState.cacheUsable && loadedState.state, "The next collector state is missing or incompatible.");
  const state = loadedState.state;
  assert(Object.keys(state.commits).length === snapshot.stats.commits, "State and snapshot commit totals differ.");
  const periodFrom = Date.parse(snapshot.period.from);
  const periodTo = Date.parse(snapshot.period.to);
  for (const commit of Object.values(state.commits)) {
    const authoredAt = Date.parse(commit.authoredAt);
    assert(authoredAt >= periodFrom && authoredAt <= periodTo, `State commit ${commit.sha} is outside the snapshot period.`);
  }

  const expectedLanguages = aggregateState(state);
  assert(expectedLanguages.length === snapshot.languages.length, "State and snapshot language totals differ.");
  const topTotal = expectedLanguages.reduce((sum, [, count]) => sum + count, 0);
  snapshot.languages.forEach((language, index) => {
    const expected = expectedLanguages[index];
    assert(expected?.[0] === language.name && expected[1] === language.commitCount, `Language ${index} does not match collector state.`);
    const expectedShare = language.commitCount / topTotal;
    assert(Math.abs(language.share - expectedShare) < 0.000001, `Language ${language.name} has an invalid share.`);
    assert(language.filledSegments === Math.max(1, Math.round(expectedShare * LANGUAGE_BAR_SEGMENTS)), `Language ${language.name} has an invalid bar.`);
    assert(language.color.toLowerCase() === classifier.colorFor(language.name).toLowerCase(), `Language ${language.name} has an invalid Linguist color.`);
  });

  assertSvg(statsSvg, "stats.svg", STATS_CARD.width, STATS_CARD.height);
  assertSvg(languagesSvg, "languages.svg", LANGUAGES_CARD.width, LANGUAGES_CARD.height);
  assert(STATS_CARD.height === LANGUAGES_CARD.height, "Card heights differ.");
  for (const language of snapshot.languages) {
    assert(languagesSvg.toLowerCase().includes(`fill="${language.color.toLowerCase()}"`), `languages.svg does not use ${language.name}'s color.`);
    const visibleCount = new RegExp(`<text[^>]*>\\s*${language.commitCount.toLocaleString("en-US")}\\s*</text>`);
    assert(!visibleCount.test(languagesSvg), `languages.svg exposes ${language.name}'s numeric total.`);
  }
  const segmentCount = languagesSvg.match(/width="6" height="10"/g)?.length ?? 0;
  assert(segmentCount === snapshot.languages.length * LANGUAGE_BAR_SEGMENTS, "languages.svg has an invalid number of graph segments.");
  assert(preview.includes('src="./stats.svg"') && preview.includes('src="./languages.svg"'), "index.html does not reference both cards.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
