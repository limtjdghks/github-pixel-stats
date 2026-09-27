import type { SearchCommit } from "../model.js";
import { parseUsername, usernamesEqual } from "../username.js";

export type PageRequest =
  | { kind: "profile"; username: string }
  | { kind: "repositories"; username: string; page: number }
  | { kind: "search"; username: string; from: number; to: number; page: number }
  | { kind: "files"; repository: string; sha: string; page: number };

export type PageResult =
  | { kind: "profile"; login: string; publicRepositories: number }
  | { kind: "repositories"; stars: number; hasNext: boolean }
  | { kind: "search"; commits: SearchCommit[]; totalCount: number; incomplete: boolean; hasNext: boolean }
  | { kind: "files"; filenames: string[]; fileCount: number; hasNext: boolean };

export interface GitHubPageSource {
  requestPage(request: PageRequest, signal: AbortSignal): Promise<PageResult>;
}

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
  login: string;
  public_repos: number;
}

interface RepositoryResponse {
  fork: boolean;
  private: boolean;
  stargazers_count: number;
}

export const MAX_RETRIES = 3;
export const MAX_RATE_LIMIT_WAIT_MS = 60_000;

function hasNextPage(link: string | null): boolean {
  return link?.split(",").some((part) => /rel="next"/.test(part)) ?? false;
}

function toApiTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function commitKey(commit: SearchCommit): string {
  return `${commit.repositoryId}:${commit.sha}`;
}

export function splitSearchInterval(from: number, to: number): [{ from: number; to: number }, { from: number; to: number }] {
  if (to - from < 2_000) {
    throw new Error(`Commit search is incomplete within a one-second range: ${toApiTimestamp(from)}.`);
  }
  const midpoint = Math.floor((from + to) / 2_000) * 1_000;
  if (midpoint <= from || midpoint >= to) {
    throw new Error(`Commit search range cannot be split safely: ${toApiTimestamp(from)}..${toApiTimestamp(to)}.`);
  }
  return [{ from, to: midpoint }, { from: midpoint + 1_000, to }];
}

function getRateLimitNumber(headers: Headers, name: string): number | null {
  const value = headers.get(name)?.trim();
  if (!value) {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function getRateLimitDelay(response: Response, now = Date.now()): number | null {
  if (response.status !== 403 && response.status !== 429) {
    return null;
  }
  const retryAfter = getRateLimitNumber(response.headers, "retry-after");
  if (retryAfter !== null) {
    return Math.max(1_000, retryAfter * 1_000);
  }
  const remaining = response.headers.get("x-ratelimit-remaining");
  const reset = getRateLimitNumber(response.headers, "x-ratelimit-reset");
  if (remaining === "0" && reset !== null) {
    return Math.max(1_000, reset * 1_000 - now + 1_000);
  }
  return null;
}

export class GitHubRequestError extends Error {
  constructor(message: string, readonly retryDelayMs: number | null, readonly status?: number) {
    super(message);
    this.name = "GitHubRequestError";
  }
}

function pageUrl(request: PageRequest): URL {
  let path: string;
  let search = new URLSearchParams();
  switch (request.kind) {
    case "profile":
      path = `/users/${request.username}`;
      break;
    case "repositories":
      path = `/users/${request.username}/repos`;
      search = new URLSearchParams({ type: "owner", sort: "full_name", direction: "asc", per_page: "100", page: String(request.page) });
      break;
    case "search":
      path = "/search/commits";
      search = new URLSearchParams({
        q: `author:${request.username} author-date:${toApiTimestamp(request.from)}..${toApiTimestamp(request.to)} is:public merge:false`,
        sort: "author-date", order: "asc", per_page: "100", page: String(request.page),
      });
      break;
    case "files":
      path = `/repos/${request.repository}/commits/${request.sha}`;
      search = new URLSearchParams({ per_page: "100", page: String(request.page) });
      break;
  }
  const url = new URL(`https://api.github.com${path}`);
  url.search = search.toString();
  return url;
}

function parsePage(request: PageRequest, body: unknown, headers: Headers): PageResult {
  const hasNext = hasNextPage(headers.get("link"));
  switch (request.kind) {
    case "profile": {
      const user = body as UserResponse;
      const login = parseUsername(user.login);
      if (!usernamesEqual(request.username, login)) {
        throw new Error(`GitHub returned an unexpected login for ${request.username}.`);
      }
      return { kind: "profile", login, publicRepositories: user.public_repos };
    }
    case "repositories": {
      const repositories = body as RepositoryResponse[];
      const stars = repositories.filter((repository) => !repository.fork && !repository.private)
        .reduce((sum, repository) => sum + repository.stargazers_count, 0);
      return { kind: "repositories", stars, hasNext };
    }
    case "search": {
      const response = body as SearchResponse;
      const items = response.incomplete_results || (request.page === 1 && response.total_count >= 1_000) ? [] : response.items;
      const commits = items.map((item) => {
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
      return { kind: "search", commits, totalCount: response.total_count, incomplete: response.incomplete_results, hasNext };
    }
    case "files": {
      const response = body as CommitResponse;
      if (!Array.isArray(response.files)) {
        throw new Error(`GitHub did not return a file list for ${request.repository}@${request.sha}.`);
      }
      const filenames = response.files.flatMap((file) => file.previous_filename
        ? [file.filename, file.previous_filename] : [file.filename]);
      return { kind: "files", filenames, fileCount: response.files.length, hasNext };
    }
  }
}

export class GitHubRestPageSource implements GitHubPageSource {
  constructor(private readonly token: string) {}

  async requestPage(request: PageRequest, signal: AbortSignal): Promise<PageResult> {
    signal.throwIfAborted();
    const url = pageUrl(request);
    const response = await fetch(url, {
      signal,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "User-Agent": "github-pixel-stats",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    signal.throwIfAborted();
    if (!response.ok) {
      const rateReset = getRateLimitNumber(response.headers, "x-ratelimit-reset");
      const resetDate = rateReset === null ? null : new Date(rateReset * 1_000);
      const resetHint = resetDate !== null && !Number.isNaN(resetDate.getTime())
        ? ` Rate limit resets at ${resetDate.toISOString()}.` : "";
      throw new GitHubRequestError(
        `GitHub API ${response.status} for ${url.pathname}.${resetHint}`,
        getRateLimitDelay(response),
        response.status,
      );
    }
    const body: unknown = await response.json();
    signal.throwIfAborted();
    return parsePage(request, body, response.headers);
  }
}
