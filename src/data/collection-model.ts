import { LANGUAGE_BAR_SEGMENTS } from "../config.js";
import type {
  CachedCommit,
  CollectionMetrics,
  CollectionResult,
  CollectorState,
  LanguageStat,
} from "../model.js";
import {
  CLASSIFIER_VERSION,
  LINGUIST_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  STATE_SCHEMA_VERSION,
} from "../model.js";
import { aggregateActivity } from "./activity.js";
import type { LanguageClassifier } from "./collection-ports.js";

export function collectionPeriod(requestedNow: Date): { now: Date; from: Date } {
  const now = new Date(Math.floor(requestedNow.getTime() / 1_000) * 1_000);
  const year = now.getUTCFullYear() - 1;
  const month = now.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const from = new Date(
    Date.UTC(
      year,
      month,
      Math.min(now.getUTCDate(), lastDay),
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
    ),
  );
  return { now, from };
}

export function aggregateLanguages(commits: CachedCommit[], classifier: Pick<LanguageClassifier, "colorFor">): LanguageStat[] {
  const counts = new Map<string, number>();
  for (const commit of commits) {
    for (const language of new Set(commit.languages)) {
      counts.set(language, (counts.get(language) ?? 0) + 1);
    }
  }
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const top = [...counts]
    .sort(([leftName, leftCount], [rightName, rightCount]) => rightCount - leftCount || leftName.localeCompare(rightName))
    .slice(0, 5);
  return top.map(([name, commitCount]) => {
    const share = total === 0 ? 0 : commitCount / total;
    return {
      name,
      commitCount,
      share: Number(share.toFixed(6)),
      filledSegments: commitCount === 0 ? 0 : Math.max(1, Math.round(share * LANGUAGE_BAR_SEGMENTS)),
      color: classifier.colorFor(name),
    };
  });
}

export function hasStateContentChanged(previous: CollectorState | null, next: CollectorState): boolean {
  if (!previous) {
    return true;
  }
  return previous.username !== next.username || JSON.stringify(previous.commits) !== JSON.stringify(next.commits);
}

interface AssembleOptions {
  username: string;
  now: Date;
  from: Date;
  publicRepositories: number;
  stars: number;
  searchedCommits: number;
  commits: Map<string, CachedCommit>;
  previous: CollectorState | null;
  metrics: CollectionMetrics;
  classifier: Pick<LanguageClassifier, "colorFor">;
}

export function assembleCollectionResult(options: AssembleOptions): CollectionResult {
  const { username, now, from, publicRepositories, stars, searchedCommits, commits, previous, metrics, classifier } = options;
  const orderedCommits = Object.fromEntries([...commits].sort(([left], [right]) => left.localeCompare(right)));
  const provisional: CollectorState = {
    schemaVersion: STATE_SCHEMA_VERSION,
    username,
    classifier: { version: CLASSIFIER_VERSION, linguistVersion: LINGUIST_VERSION },
    updatedAt: now.toISOString(),
    commits: orderedCommits,
  };
  const stateChanged = hasStateContentChanged(previous, provisional);
  const nextState: CollectorState = {
    ...provisional,
    updatedAt: stateChanged ? now.toISOString() : (previous?.updatedAt ?? now.toISOString()),
  };
  const cachedCommits = [...commits.values()];
  return {
    snapshot: {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      username,
      generatedAt: now.toISOString(),
      period: { from: from.toISOString(), to: now.toISOString(), label: "Last 12 months" },
      stats: { commits: searchedCommits, publicRepositories, stars },
      languages: aggregateLanguages(cachedCommits, classifier),
      activity: aggregateActivity(cachedCommits, from.toISOString(), now.toISOString()),
      source: {
        commitScope: "public-default-branches",
        languageMetric: "commits-touching-language",
      },
    },
    nextState,
    stateChanged,
    metrics,
  };
}
