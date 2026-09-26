import type { SearchCommit } from "../model.js";
import type { LoadedState } from "./state.js";

export interface GitHubSource {
  searchCommits(username: string, from: Date, to: Date): Promise<SearchCommit[]>;
  getCommitFilenames(repository: string, sha: string): Promise<string[]>;
  getProfileStats(username: string): Promise<{ login: string; publicRepositories: number; stars: number }>;
}

export interface LanguageClassifier {
  classifyFiles(paths: string[]): string[];
  colorFor(language: string): string;
}

export interface CollectionDependencies {
  github: GitHubSource;
  loadState(username: string): Promise<LoadedState>;
  loadClassifier(): Promise<LanguageClassifier>;
  now(): Date;
}
