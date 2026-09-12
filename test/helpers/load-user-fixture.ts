import { readFile } from "node:fs/promises";
import type { CollectorState, SearchCommit, StatsSnapshot } from "../../src/model.js";
import {
  CLASSIFIER_VERSION,
  LINGUIST_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  STATE_SCHEMA_VERSION,
  USERNAME,
} from "../../src/model.js";

const USERNAME_SENTINEL = "__CURRENT_USERNAME__" as const;

export const USER_FIXTURE_NAMES = ["fixture-alpha", "fixture-beta"] as const;

export type UserFixtureName = (typeof USER_FIXTURE_NAMES)[number];

interface ApiPage<T> {
  query: Record<string, string>;
  headers?: Record<string, string>;
  body: T;
}

interface SearchResponseBody {
  total_count: number;
  incomplete_results: boolean;
  items: Array<{
    sha: string;
    commit: { author: { date: string } | null };
    repository: { id: number; full_name: string };
  }>;
}

interface CommitResponseBody {
  files: Array<{ filename: string; previous_filename?: string }>;
}

interface RepositoryResponseBody {
  fork: boolean;
  private: boolean;
  stargazers_count: number;
}

export interface GitHubResponsesFixture {
  username: string;
  period: { from: string; to: string };
  searchCommits: {
    path: "/search/commits";
    pages: Array<ApiPage<SearchResponseBody>>;
    expected: SearchCommit[];
  };
  commitDetails: {
    path: string;
    repository: string;
    sha: string;
    pages: Array<ApiPage<CommitResponseBody>>;
    expectedFilenames: string[];
  };
  userProfile: {
    path: string;
    query: Record<string, string>;
    body: { public_repos: number };
  };
  ownedRepositories: {
    path: string;
    pages: Array<ApiPage<RepositoryResponseBody[]>>;
  };
  expectedProfileStats: {
    publicRepositories: number;
    stars: number;
  };
}

type FixtureState = Omit<CollectorState, "username"> & { username: typeof USERNAME_SENTINEL };
type FixtureSnapshot = Omit<StatsSnapshot, "username"> & { username: typeof USERNAME_SENTINEL };

export interface UserFixture {
  id: UserFixtureName;
  githubResponses: GitHubResponsesFixture;
  state: CollectorState;
  snapshot: StatsSnapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function assertApiPages<T>(
  value: unknown,
  context: string,
  assertBody: (body: unknown) => asserts body is T,
): asserts value is Array<ApiPage<T>> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${context} must contain at least one page.`);
  }
  for (const page of value) {
    if (!isRecord(page) || !isStringRecord(page.query) || (page.headers !== undefined && !isStringRecord(page.headers))) {
      throw new Error(`${context} contains an invalid page.`);
    }
    assertBody(page.body);
  }
}

function assertSearchResponseBody(value: unknown): asserts value is SearchResponseBody {
  if (
    !isRecord(value) ||
    !isNonNegativeInteger(value.total_count) ||
    typeof value.incomplete_results !== "boolean" ||
    !Array.isArray(value.items)
  ) {
    throw new Error("GitHub search fixture has an invalid response body.");
  }
  for (const item of value.items) {
    if (
      !isRecord(item) ||
      typeof item.sha !== "string" ||
      !isRecord(item.commit) ||
      (item.commit.author !== null &&
        (!isRecord(item.commit.author) || !isTimestamp(item.commit.author.date))) ||
      !isRecord(item.repository) ||
      !Number.isSafeInteger(item.repository.id) ||
      typeof item.repository.full_name !== "string"
    ) {
      throw new Error("GitHub search fixture contains an invalid commit item.");
    }
  }
}

function assertExpectedCommits(value: unknown): asserts value is SearchCommit[] {
  if (!Array.isArray(value)) {
    throw new Error("GitHub search fixture expected commits must be an array.");
  }
  for (const commit of value) {
    if (
      !isRecord(commit) ||
      !Number.isSafeInteger(commit.repositoryId) ||
      typeof commit.repository !== "string" ||
      typeof commit.sha !== "string" ||
      !isTimestamp(commit.authoredAt)
    ) {
      throw new Error("GitHub search fixture contains an invalid expected commit.");
    }
  }
}

function assertCommitResponseBody(value: unknown): asserts value is CommitResponseBody {
  if (!isRecord(value) || !Array.isArray(value.files)) {
    throw new Error("GitHub commit fixture has an invalid response body.");
  }
  for (const file of value.files) {
    if (
      !isRecord(file) ||
      typeof file.filename !== "string" ||
      (file.previous_filename !== undefined && typeof file.previous_filename !== "string")
    ) {
      throw new Error("GitHub commit fixture contains an invalid file.");
    }
  }
}

function assertRepositoryResponseBody(value: unknown): asserts value is RepositoryResponseBody[] {
  if (!Array.isArray(value)) {
    throw new Error("GitHub repositories fixture response must be an array.");
  }
  for (const repository of value) {
    if (
      !isRecord(repository) ||
      typeof repository.fork !== "boolean" ||
      typeof repository.private !== "boolean" ||
      !isNonNegativeInteger(repository.stargazers_count)
    ) {
      throw new Error("GitHub repositories fixture contains an invalid repository.");
    }
  }
}

function assertGitHubResponsesFixture(value: unknown): asserts value is GitHubResponsesFixture {
  if (!isRecord(value) || typeof value.username !== "string" || value.username.length === 0) {
    throw new Error("GitHub responses fixture has an invalid username.");
  }
  if (!isRecord(value.period) || !isTimestamp(value.period.from) || !isTimestamp(value.period.to)) {
    throw new Error("GitHub responses fixture has an invalid period.");
  }

  if (!isRecord(value.searchCommits) || value.searchCommits.path !== "/search/commits") {
    throw new Error("GitHub responses fixture has an invalid search definition.");
  }
  assertApiPages(value.searchCommits.pages, "GitHub search fixture", assertSearchResponseBody);
  assertExpectedCommits(value.searchCommits.expected);

  if (
    !isRecord(value.commitDetails) ||
    typeof value.commitDetails.path !== "string" ||
    typeof value.commitDetails.repository !== "string" ||
    typeof value.commitDetails.sha !== "string" ||
    !Array.isArray(value.commitDetails.expectedFilenames) ||
    !value.commitDetails.expectedFilenames.every((filename) => typeof filename === "string")
  ) {
    throw new Error("GitHub responses fixture has an invalid commit detail definition.");
  }
  assertApiPages(value.commitDetails.pages, "GitHub commit fixture", assertCommitResponseBody);

  if (
    !isRecord(value.userProfile) ||
    typeof value.userProfile.path !== "string" ||
    !isStringRecord(value.userProfile.query) ||
    !isRecord(value.userProfile.body) ||
    !isNonNegativeInteger(value.userProfile.body.public_repos)
  ) {
    throw new Error("GitHub responses fixture has an invalid user profile definition.");
  }
  if (!isRecord(value.ownedRepositories) || typeof value.ownedRepositories.path !== "string") {
    throw new Error("GitHub responses fixture has an invalid repositories definition.");
  }
  assertApiPages(
    value.ownedRepositories.pages,
    "GitHub repositories fixture",
    assertRepositoryResponseBody,
  );

  if (
    !isRecord(value.expectedProfileStats) ||
    !isNonNegativeInteger(value.expectedProfileStats.publicRepositories) ||
    !isNonNegativeInteger(value.expectedProfileStats.stars)
  ) {
    throw new Error("GitHub responses fixture has invalid expected profile stats.");
  }
}

export function parseGitHubResponsesFixture(value: unknown): GitHubResponsesFixture {
  assertGitHubResponsesFixture(value);
  return value;
}

function assertFixtureState(value: unknown): asserts value is FixtureState {
  if (!isRecord(value) || value.username !== USERNAME_SENTINEL) {
    throw new Error(`Fixture state username must be ${USERNAME_SENTINEL}.`);
  }
  if (
    value.schemaVersion !== STATE_SCHEMA_VERSION ||
    !isRecord(value.classifier) ||
    value.classifier.version !== CLASSIFIER_VERSION ||
    value.classifier.linguistVersion !== LINGUIST_VERSION ||
    !isTimestamp(value.updatedAt) ||
    !isRecord(value.commits)
  ) {
    throw new Error("Fixture state has an invalid shape.");
  }

  for (const [key, commit] of Object.entries(value.commits)) {
    if (
      !isRecord(commit) ||
      !Number.isSafeInteger(commit.repositoryId) ||
      Number(commit.repositoryId) <= 0 ||
      typeof commit.repository !== "string" ||
      !commit.repository.includes("/") ||
      typeof commit.sha !== "string" ||
      !/^[\da-f]{40}(?:[\da-f]{24})?$/i.test(commit.sha) ||
      !isTimestamp(commit.authoredAt) ||
      !Array.isArray(commit.languages) ||
      !commit.languages.every((language) => typeof language === "string" && language.length > 0) ||
      new Set(commit.languages).size !== commit.languages.length ||
      `${commit.repositoryId}:${commit.sha}` !== key
    ) {
      throw new Error(`Fixture state commit ${key} has an invalid shape.`);
    }
  }
}

function assertFixtureSnapshot(value: unknown): asserts value is FixtureSnapshot {
  if (!isRecord(value) || value.username !== USERNAME_SENTINEL) {
    throw new Error(`Fixture snapshot username must be ${USERNAME_SENTINEL}.`);
  }
  if (
    value.schemaVersion !== SNAPSHOT_SCHEMA_VERSION ||
    !isTimestamp(value.generatedAt) ||
    !isRecord(value.period) ||
    !isTimestamp(value.period.from) ||
    !isTimestamp(value.period.to) ||
    value.period.label !== "Last 12 months" ||
    !isRecord(value.stats) ||
    !Number.isSafeInteger(value.stats.commits) ||
    Number(value.stats.commits) < 0 ||
    !Number.isSafeInteger(value.stats.publicRepositories) ||
    Number(value.stats.publicRepositories) < 0 ||
    !Number.isSafeInteger(value.stats.stars) ||
    Number(value.stats.stars) < 0 ||
    !Array.isArray(value.languages) ||
    !isRecord(value.activity) ||
    value.activity.timezone !== "UTC" ||
    !Array.isArray(value.activity.days) ||
    !isRecord(value.source) ||
    value.source.commitScope !== "public-default-branches" ||
    value.source.languageMetric !== "commits-touching-language"
  ) {
    throw new Error("Fixture snapshot has an invalid shape.");
  }

  for (const language of value.languages) {
    if (
      !isRecord(language) ||
      typeof language.name !== "string" ||
      !Number.isSafeInteger(language.commitCount) ||
      typeof language.share !== "number" ||
      !Number.isSafeInteger(language.filledSegments) ||
      typeof language.color !== "string"
    ) {
      throw new Error("Fixture snapshot contains an invalid language.");
    }
  }
  for (const day of value.activity.days) {
    if (!isRecord(day) || typeof day.date !== "string" || !Number.isSafeInteger(day.commits)) {
      throw new Error("Fixture snapshot contains an invalid activity day.");
    }
  }
}

async function readJson(url: URL): Promise<unknown> {
  return JSON.parse(await readFile(url, "utf8")) as unknown;
}

export async function loadUserFixture(name: UserFixtureName): Promise<UserFixture> {
  const fixtureUrl = new URL(`../fixtures/users/${name}/`, import.meta.url);
  const [githubResponses, state, snapshot] = await Promise.all([
    readJson(new URL("github-responses.json", fixtureUrl)),
    readJson(new URL("state.json", fixtureUrl)),
    readJson(new URL("snapshot.json", fixtureUrl)),
  ]);
  const parsedGitHubResponses = parseGitHubResponsesFixture(githubResponses);
  assertFixtureState(state);
  assertFixtureSnapshot(snapshot);

  return {
    id: name,
    githubResponses: parsedGitHubResponses,
    state: { ...state, username: USERNAME },
    snapshot: { ...snapshot, username: USERNAME },
  };
}
