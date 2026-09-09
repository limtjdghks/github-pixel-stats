import { LANGUAGE_BAR_SEGMENTS } from "../config.js";
import type {
  CachedCommit,
  CollectionMetrics,
  CollectionResult,
  CollectorState,
  LanguageStat,
  SearchCommit,
} from "../model.js";
import {
  CLASSIFIER_VERSION,
  LINGUIST_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  STATE_SCHEMA_VERSION,
  USERNAME,
} from "../model.js";
import { aggregateActivity } from "./activity.js";
import { GitHubClient } from "./github-client.js";
import { LinguistClassifier } from "./linguist.js";
import { hasStateContentChanged, loadState } from "./state.js";

export interface CollectOptions {
  token: string;
  statePath: string;
  now?: Date;
}

export class CollectionFailure extends Error {
  constructor(message: string, readonly metrics: CollectionMetrics, cause: unknown) {
    super(message, { cause });
    this.name = "CollectionFailure";
  }
}

function keyOf(commit: SearchCommit): string {
  return `${commit.repositoryId}:${commit.sha}`;
}

function twelveMonthsBefore(date: Date): Date {
  const year = date.getUTCFullYear() - 1;
  const month = date.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(date.getUTCDate(), lastDay),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
    ),
  );
}

function aggregateLanguages(commits: CachedCommit[], classifier: LinguistClassifier): LanguageStat[] {
  const counts = new Map<string, number>();
  for (const commit of commits) {
    for (const language of new Set(commit.languages)) {
      counts.set(language, (counts.get(language) ?? 0) + 1);
    }
  }
  const top = [...counts]
    .sort(([leftName, leftCount], [rightName, rightCount]) => rightCount - leftCount || leftName.localeCompare(rightName))
    .slice(0, 5);
  const total = top.reduce((sum, [, count]) => sum + count, 0);
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

function orderedRecord(commits: Map<string, CachedCommit>): Record<string, CachedCommit> {
  return Object.fromEntries([...commits].sort(([left], [right]) => left.localeCompare(right)));
}

export async function collectStats(options: CollectOptions): Promise<CollectionResult> {
  const requestedNow = options.now ?? new Date();
  const now = new Date(Math.floor(requestedNow.getTime() / 1_000) * 1_000);
  const metrics: CollectionMetrics = {
    searchedCommits: 0,
    cacheHits: 0,
    fetchedCommits: 0,
    removedCommits: 0,
  };

  try {
    const from = twelveMonthsBefore(now);
    const client = new GitHubClient(options.token);
    const classifier = await LinguistClassifier.loadDefault();
    const loaded = await loadState(options.statePath);
    const previous = loaded.cacheUsable ? loaded.state : null;
    const searched = await client.searchCommits(USERNAME, from, now);
    metrics.searchedCommits = searched.length;
    const searchedKeys = new Set(searched.map(keyOf));
    const commits = new Map<string, CachedCommit>();

    for (const commit of searched) {
      const key = keyOf(commit);
      const cached = previous?.commits[key];
      if (cached) {
        metrics.cacheHits += 1;
        commits.set(key, { ...commit, languages: cached.languages });
        continue;
      }
      const filenames = await client.getCommitFilenames(commit.repository, commit.sha);
      commits.set(key, { ...commit, languages: classifier.classifyFiles(filenames) });
      metrics.fetchedCommits += 1;
    }

    metrics.removedCommits = previous
      ? Object.keys(previous.commits).filter((key) => !searchedKeys.has(key)).length
      : 0;
    const provisional: CollectorState = {
      schemaVersion: STATE_SCHEMA_VERSION,
      username: USERNAME,
      classifier: { version: CLASSIFIER_VERSION, linguistVersion: LINGUIST_VERSION },
      updatedAt: now.toISOString(),
      commits: orderedRecord(commits),
    };
    const stateChanged = hasStateContentChanged(previous, provisional);
    const nextState: CollectorState = {
      ...provisional,
      updatedAt: stateChanged ? now.toISOString() : (previous?.updatedAt ?? now.toISOString()),
    };
    const profile = await client.getProfileStats(USERNAME);
    const languages = aggregateLanguages([...commits.values()], classifier);

    return {
      snapshot: {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        username: USERNAME,
        generatedAt: now.toISOString(),
        period: { from: from.toISOString(), to: now.toISOString(), label: "Last 12 months" },
        stats: {
          commits: searched.length,
          publicRepositories: profile.publicRepositories,
          stars: profile.stars,
        },
        languages,
        activity: aggregateActivity([...commits.values()], from.toISOString(), now.toISOString()),
        source: {
          commitScope: "public-default-branches",
          languageMetric: "commits-touching-language",
        },
      },
      nextState,
      stateChanged,
      metrics,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CollectionFailure(message, metrics, error);
  }
}
