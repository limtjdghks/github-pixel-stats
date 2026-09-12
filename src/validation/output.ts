import { XMLValidator } from "fast-xml-parser";
import { LANGUAGE_BAR_SEGMENTS, LANGUAGES_CARD, STATS_CARD } from "../config.js";
import type { LinguistClassifier } from "../data/linguist.js";
import type { CachedCommit, CollectorState, LanguageStat, StatsSnapshot } from "../model.js";
import { SNAPSHOT_SCHEMA_VERSION, USERNAME } from "../model.js";

export interface GeneratedOutput {
  snapshot: unknown;
  state: CollectorState;
  statsSvg: string;
  languagesSvg: string;
  preview: string;
  classifier: LinguistClassifier;
}

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

export function assertSnapshot(value: unknown): asserts value is StatsSnapshot {
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
  assert(isRecord(value.activity) && value.activity.timezone === "UTC", "data.json has invalid activity metadata.");
  assert(Array.isArray(value.activity.days), "data.json has no activity days.");
  const firstDate = new Date(value.period.from).toISOString().slice(0, 10);
  const lastDate = new Date(value.period.to).toISOString().slice(0, 10);
  const firstDay = Date.parse(`${firstDate}T00:00:00Z`);
  const lastDay = Date.parse(`${lastDate}T00:00:00Z`);
  const expectedDayCount = (lastDay - firstDay) / 86_400_000 + 1;
  assert(value.activity.days.length === expectedDayCount, "data.json activity does not cover the entire period.");
  let activityTotal = 0;
  value.activity.days.forEach((day: unknown, index: number) => {
    assert(isRecord(day), `Activity day ${index} is not an object.`);
    const expectedDate = new Date(firstDay + index * 86_400_000).toISOString().slice(0, 10);
    assert(day.date === expectedDate, `Activity day ${index} has an invalid date sequence.`);
    assert(Number.isSafeInteger(day.commits) && Number(day.commits) >= 0, `Activity day ${index} has an invalid count.`);
    activityTotal += Number(day.commits);
  });
  assert(activityTotal === value.stats.commits, "Activity and snapshot commit totals differ.");
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
  );
}

export function assertSvg(svg: string, name: string, width: number, height: number): void {
  const xmlResult = XMLValidator.validate(svg);
  assert(xmlResult === true, `${name} is not valid XML.`);
  assert(svg.includes(`width="${width}" height="${height}"`), `${name} has an unexpected size.`);
  assert(svg.includes(`viewBox="0 0 ${width} ${height}"`), `${name} has an unexpected viewBox.`);
  assert(svg.includes("role=\"img\""), `${name} has no image role.`);
  assert(svg.includes("aria-labelledby="), `${name} has no accessible label relationship.`);
  assert(/<title\s+id="[^"]+">.+<\/title>/.test(svg), `${name} has no title.`);
  assert(/<desc\s+id="[^"]+">.+<\/desc>/.test(svg), `${name} has no description.`);
  assert(svg.includes("shape-rendering=\"crispEdges\""), `${name} does not use crisp pixel rendering.`);
  assert(svg.includes("data:font/woff2;base64,"), `${name} does not embed a pixel font.`);
  assert(!/<script\b/i.test(svg), `${name} contains a script.`);
  assert(!/<foreignObject\b/i.test(svg), `${name} contains foreignObject.`);
  const withoutNamespace = svg.replace('xmlns="http://www.w3.org/2000/svg"', "");
  assert(!/https?:\/\//i.test(withoutNamespace), `${name} contains an external URL.`);
  assert(!/(?:href|src)=["']\/\//i.test(withoutNamespace), `${name} contains a protocol-relative URL.`);
}

export function validateGeneratedOutput({
  snapshot,
  state,
  statsSvg,
  languagesSvg,
  preview,
  classifier,
}: GeneratedOutput): void {
  assertSnapshot(snapshot);
  assert(Object.keys(state.commits).length === snapshot.stats.commits, "State and snapshot commit totals differ.");
  const periodFrom = Date.parse(snapshot.period.from);
  const periodTo = Date.parse(snapshot.period.to);
  for (const commit of Object.values(state.commits)) {
    const authoredAt = Date.parse(commit.authoredAt);
    assert(authoredAt >= periodFrom && authoredAt <= periodTo, `State commit ${commit.sha} is outside the snapshot period.`);
  }

  const authoredDateCounts = new Map<string, number>();
  for (const commit of Object.values(state.commits)) {
    const date = new Date(commit.authoredAt).toISOString().slice(0, 10);
    authoredDateCounts.set(date, (authoredDateCounts.get(date) ?? 0) + 1);
  }
  for (const day of snapshot.activity.days) {
    assert(day.commits === (authoredDateCounts.get(day.date) ?? 0), `Activity count for ${day.date} does not match collector state.`);
  }

  const allLanguageCounts = aggregateState(state);
  const expectedLanguages = allLanguageCounts.slice(0, 5);
  assert(expectedLanguages.length === snapshot.languages.length, "State and snapshot language totals differ.");
  const allLanguageTotal = allLanguageCounts.reduce((sum, [, count]) => sum + count, 0);
  snapshot.languages.forEach((language, index) => {
    const expected = expectedLanguages[index];
    assert(expected?.[0] === language.name && expected[1] === language.commitCount, `Language ${index} does not match collector state.`);
    const expectedShare = language.commitCount / allLanguageTotal;
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
  const activityCells = [...statsSvg.matchAll(/<rect\b[^>]*\bdata-activity-date="([^"]+)"[^>]*>/g)];
  assert(activityCells.length === snapshot.activity.days.length, "stats.svg has an invalid number of activity cells.");
  const visibleActivity = new Map<string, number>();
  for (const cell of activityCells) {
    const date = cell[1];
    const countMatch = /\bdata-activity-count="(\d+)"/.exec(cell[0]);
    assert(date && countMatch, "stats.svg has an invalid activity cell.");
    assert(!visibleActivity.has(date), `stats.svg repeats activity date ${date}.`);
    visibleActivity.set(date, Number(countMatch[1]));
  }
  for (const day of snapshot.activity.days) {
    assert(visibleActivity.get(day.date) === day.commits, `stats.svg has an invalid activity count for ${day.date}.`);
  }
  const segmentCount = languagesSvg.match(/\bdata-language-segment="true"/g)?.length ?? 0;
  assert(segmentCount === snapshot.languages.length * LANGUAGE_BAR_SEGMENTS, "languages.svg has an invalid number of graph segments.");
  assert(preview.includes('src="./stats.svg"') && preview.includes('src="./languages.svg"'), "index.html does not reference both cards.");
}
