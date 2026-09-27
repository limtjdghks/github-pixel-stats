import type { SearchCommit } from "../model.js";
import {
  commitKey,
  GitHubRequestError,
  GitHubRestPageSource,
  MAX_RATE_LIMIT_WAIT_MS,
  MAX_RETRIES,
  splitSearchInterval,
  type PageRequest,
  type PageResult,
} from "./github-pages.js";

export class GitHubClient extends GitHubRestPageSource {
  async searchCommits(username: string, from: Date, to: Date): Promise<SearchCommit[]> {
    const commits = await this.searchRange(username, from.getTime(), to.getTime());
    return [...new Map(commits.map((commit) => [commitKey(commit), commit])).values()].sort(
      (left, right) => left.authoredAt.localeCompare(right.authoredAt) || commitKey(left).localeCompare(commitKey(right)),
    );
  }

  async getCommitFilenames(repository: string, sha: string): Promise<string[]> {
    const filenames: string[] = [];
    let fileCount = 0;
    let page = 1;
    while (true) {
      const response = await this.requestWithRetry({ kind: "files", repository, sha, page });
      fileCount += response.fileCount;
      filenames.push(...response.filenames);
      if (fileCount >= 3_000) {
        throw new Error(`Commit ${repository}@${sha} reached GitHub's 3,000-file response limit.`);
      }
      if (!response.hasNext) {
        return filenames;
      }
      page += 1;
    }
  }

  async getProfileStats(username: string): Promise<{ login: string; publicRepositories: number; stars: number }> {
    const user = await this.requestWithRetry({ kind: "profile", username });
    let stars = 0;
    let page = 1;
    while (true) {
      const response = await this.requestWithRetry({ kind: "repositories", username: user.login, page });
      stars += response.stars;
      if (!response.hasNext) {
        break;
      }
      page += 1;
    }
    return { login: user.login, publicRepositories: user.publicRepositories, stars };
  }

  private async searchRange(username: string, from: number, to: number): Promise<SearchCommit[]> {
    const first = await this.requestWithRetry({ kind: "search", username, from, to, page: 1 });
    if (first.incomplete || first.totalCount >= 1_000) {
      return this.splitSearchRange(username, from, to);
    }
    const commits = first.commits;
    let page = 1;
    let nextPage = first.hasNext;
    while (nextPage) {
      page += 1;
      const response = await this.requestWithRetry({ kind: "search", username, from, to, page });
      if (response.incomplete) {
        return this.splitSearchRange(username, from, to);
      }
      commits.push(...response.commits);
      nextPage = response.hasNext;
    }
    const uniqueCommitCount = new Set(commits.map(commitKey)).size;
    if (uniqueCommitCount !== commits.length || commits.length !== first.totalCount) {
      return this.splitSearchRange(username, from, to);
    }
    return commits;
  }

  private async splitSearchRange(username: string, from: number, to: number): Promise<SearchCommit[]> {
    const [leftRange, rightRange] = splitSearchInterval(from, to);
    const left = await this.searchRange(username, leftRange.from, leftRange.to);
    const right = await this.searchRange(username, rightRange.from, rightRange.to);
    return [...left, ...right];
  }

  private async requestWithRetry<T extends PageRequest>(request: T): Promise<Extract<PageResult, { kind: T["kind"] }>> {
    const signal = new AbortController().signal;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.requestPage(request, signal) as Extract<PageResult, { kind: T["kind"] }>;
      } catch (error) {
        if (!(error instanceof GitHubRequestError) || error.retryDelayMs === null
          || error.retryDelayMs > MAX_RATE_LIMIT_WAIT_MS || attempt >= MAX_RETRIES) {
          throw error;
        }
        const delay = error.retryDelayMs;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
}
