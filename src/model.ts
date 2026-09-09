export const USERNAME = "limtjdghks" as const;
export const STATE_SCHEMA_VERSION = 1 as const;
export const SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const CLASSIFIER_VERSION = 1 as const;
export const LINGUIST_VERSION = "9.7.0" as const;
export const FALLBACK_LANGUAGE_COLOR = "#8B7DF1" as const;

export interface SearchCommit {
  repositoryId: number;
  repository: string;
  sha: string;
  authoredAt: string;
}

export interface CachedCommit extends SearchCommit {
  languages: string[];
}

export interface CollectorState {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  username: typeof USERNAME;
  classifier: {
    version: typeof CLASSIFIER_VERSION;
    linguistVersion: typeof LINGUIST_VERSION;
  };
  updatedAt: string;
  commits: Record<string, CachedCommit>;
}

export interface LanguageStat {
  name: string;
  commitCount: number;
  share: number;
  filledSegments: number;
  color: string;
}

export interface DailyActivity {
  timezone: "UTC";
  days: Array<{
    date: string;
    commits: number;
  }>;
}

export interface StatsSnapshot {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  username: typeof USERNAME;
  generatedAt: string;
  period: {
    from: string;
    to: string;
    label: "Last 12 months";
  };
  stats: {
    commits: number;
    publicRepositories: number;
    stars: number;
  };
  languages: LanguageStat[];
  activity: DailyActivity;
  source: {
    commitScope: "public-default-branches";
    languageMetric: "commits-touching-language";
  };
}

export interface CollectionMetrics {
  searchedCommits: number;
  cacheHits: number;
  fetchedCommits: number;
  removedCommits: number;
}

export interface CollectionResult {
  snapshot: StatsSnapshot;
  nextState: CollectorState;
  stateChanged: boolean;
  metrics: CollectionMetrics;
}
