import type { SearchCommit } from "../model.js";

interface SearchResponse {
  total_count: number;
  incomplete_results: boolean;
  items: Array<{
    sha: string;
    commit: { author: { date: string } | null };
    repository: { id: number; full_name: string };
  }>;
}

interface CommitResponse {
  files?: Array<{ filename: string; previous_filename?: string }>;
}

interface UserResponse {
  public_repos: number;
}

interface RepositoryResponse {
  fork: boolean;
  private: boolean;
  stargazers_count: number;
}

interface ApiResponse<T> {
  data: T;
  headers: Headers;
}

const API_VERSION = "2022-11-28";
const MAX_RETRIES = 3;
const MAX_RATE_LIMIT_WAIT_MS = 60_000;

function hasNextPage(link: string | null): boolean {
  return link?.split(",").some((part) => /rel="next"/.test(part)) ?? false;
}

function toApiTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function commitKey(commit: SearchCommit): string {
  return `${commit.repositoryId}:${commit.sha}`;
}

function getRateLimitDelay(response: Response): number | null {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    return Math.max(1_000, retryAfter * 1_000);
  }

  const remaining = response.headers.get("x-ratelimit-remaining");
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (remaining === "0" && Number.isFinite(reset)) {
    return Math.max(1_000, reset * 1_000 - Date.now() + 1_000);
  }

  return null;
}

export class GitHubClient {
  constructor(private readonly token: string) {}

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
      const response = await this.request<CommitResponse>(
        `/repos/${repository}/commits/${sha}`,
        new URLSearchParams({ per_page: "100", page: String(page) }),
      );
      if (!Array.isArray(response.data.files)) {
        throw new Error(`GitHub did not return a file list for ${repository}@${sha}.`);
      }

      fileCount += response.data.files.length;
      for (const file of response.data.files) {
        filenames.push(file.filename);
        if (file.previous_filename) {
          filenames.push(file.previous_filename);
        }
      }
      if (fileCount >= 3_000) {
        throw new Error(`Commit ${repository}@${sha} reached GitHub's 3,000-file response limit.`);
      }
      if (!hasNextPage(response.headers.get("link"))) {
        return filenames;
      }
      page += 1;
    }
  }

  async getProfileStats(username: string): Promise<{ publicRepositories: number; stars: number }> {
    const user = await this.request<UserResponse>(`/users/${username}`);
    let stars = 0;
    let page = 1;

    while (true) {
      const response = await this.request<RepositoryResponse[]>(
        `/users/${username}/repos`,
        new URLSearchParams({ type: "owner", sort: "full_name", direction: "asc", per_page: "100", page: String(page) }),
      );
      stars += response.data
        .filter((repository) => !repository.fork && !repository.private)
        .reduce((sum, repository) => sum + repository.stargazers_count, 0);
      if (!hasNextPage(response.headers.get("link"))) {
        break;
      }
      page += 1;
    }

    return { publicRepositories: user.data.public_repos, stars };
  }

  private async searchRange(username: string, from: number, to: number): Promise<SearchCommit[]> {
    const query = `author:${username} author-date:${toApiTimestamp(from)}..${toApiTimestamp(to)} is:public merge:false`;
    const first = await this.request<SearchResponse>(
      "/search/commits",
      new URLSearchParams({ q: query, sort: "author-date", order: "asc", per_page: "100", page: "1" }),
    );

    if (first.data.incomplete_results || first.data.total_count >= 1_000) {
      return this.splitSearchRange(username, from, to);
    }

    const commits = this.mapSearchItems(first.data);
    let page = 1;
    let nextPage = hasNextPage(first.headers.get("link"));
    while (nextPage) {
      page += 1;
      const response = await this.request<SearchResponse>(
        "/search/commits",
        new URLSearchParams({ q: query, sort: "author-date", order: "asc", per_page: "100", page: String(page) }),
      );
      if (response.data.incomplete_results) {
        return this.splitSearchRange(username, from, to);
      }
      commits.push(...this.mapSearchItems(response.data));
      nextPage = hasNextPage(response.headers.get("link"));
    }
    const uniqueCommitCount = new Set(commits.map(commitKey)).size;
    if (uniqueCommitCount !== commits.length) {
      return this.splitSearchRange(username, from, to);
    }
    if (commits.length !== first.data.total_count) {
      return this.splitSearchRange(username, from, to);
    }
    return commits;
  }

  private async splitSearchRange(username: string, from: number, to: number): Promise<SearchCommit[]> {
    if (to - from < 2_000) {
      throw new Error(`Commit search is incomplete within a one-second range: ${toApiTimestamp(from)}.`);
    }
    const midpoint = Math.floor((from + to) / 2_000) * 1_000;
    if (midpoint <= from || midpoint >= to) {
      throw new Error(`Commit search range cannot be split safely: ${toApiTimestamp(from)}..${toApiTimestamp(to)}.`);
    }
    const left = await this.searchRange(username, from, midpoint);
    const right = await this.searchRange(username, midpoint + 1_000, to);
    return [...left, ...right];
  }

  private mapSearchItems(response: SearchResponse): SearchCommit[] {
    return response.items.map((item) => {
      if (!item.commit.author?.date) {
        throw new Error(`Commit ${item.repository.full_name}@${item.sha} has no author date.`);
      }
      return {
        repositoryId: item.repository.id,
        repository: item.repository.full_name,
        sha: item.sha,
        authoredAt: item.commit.author.date,
      };
    });
  }

  private async request<T>(path: string, search = new URLSearchParams()): Promise<ApiResponse<T>> {
    const url = new URL(`https://api.github.com${path}`);
    url.search = search.toString();

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      const response = await fetch(url, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.token}`,
          "User-Agent": "github-pixel-stats",
          "X-GitHub-Api-Version": API_VERSION,
        },
      });
      if (response.ok) {
        return { data: (await response.json()) as T, headers: response.headers };
      }

      const rateLimitDelay = getRateLimitDelay(response);
      const canRetry = (response.status === 403 || response.status === 429) && attempt < MAX_RETRIES;
      if (canRetry && rateLimitDelay !== null && rateLimitDelay <= MAX_RATE_LIMIT_WAIT_MS) {
        await new Promise((resolve) => setTimeout(resolve, rateLimitDelay));
        continue;
      }

      const rateReset = response.headers.get("x-ratelimit-reset");
      const resetHint = rateReset ? ` Rate limit resets at ${new Date(Number(rateReset) * 1_000).toISOString()}.` : "";
      throw new Error(`GitHub API ${response.status} for ${path}.${resetHint}`);
    }
    throw new Error(`GitHub API retry loop ended unexpectedly for ${path}.`);
  }
}
