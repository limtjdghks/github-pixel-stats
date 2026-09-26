import type { CachedCommit, CollectionMetrics, CollectionResult, SearchCommit } from "../model.js";
import { parseUsername } from "../username.js";
import { assembleCollectionResult, collectionPeriod } from "./collection-model.js";
import type { CollectionDependencies } from "./collection-ports.js";

export interface CollectOptions {
  username: string;
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

export async function collectStats(options: CollectOptions, dependencies: CollectionDependencies): Promise<CollectionResult> {
  const { now, from } = collectionPeriod(dependencies.now());
  const metrics: CollectionMetrics = {
    searchedCommits: 0,
    cacheHits: 0,
    fetchedCommits: 0,
    removedCommits: 0,
  };

  try {
    const requestedUsername = parseUsername(options.username);
    const profile = await dependencies.github.getProfileStats(requestedUsername);
    const username = profile.login;
    const classifier = await dependencies.loadClassifier();
    const loaded = await dependencies.loadState(username);
    const previous = loaded.cacheUsable ? loaded.state : null;
    const searched = await dependencies.github.searchCommits(username, from, now);
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
      const filenames = await dependencies.github.getCommitFilenames(commit.repository, commit.sha);
      commits.set(key, { ...commit, languages: classifier.classifyFiles(filenames) });
      metrics.fetchedCommits += 1;
    }

    metrics.removedCommits = previous
      ? Object.keys(previous.commits).filter((key) => !searchedKeys.has(key)).length
      : 0;
    return assembleCollectionResult({
      username,
      now,
      from,
      publicRepositories: profile.publicRepositories,
      stars: profile.stars,
      searchedCommits: searched.length,
      commits,
      previous,
      metrics,
      classifier,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CollectionFailure(message, metrics, error);
  }
}
