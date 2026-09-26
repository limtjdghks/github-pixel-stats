import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { GitHubClient } from "../src/data/github-client.js";
import {
  loadUserFixture,
  USER_FIXTURE_NAMES,
  type GitHubResponsesFixture,
} from "./helpers/load-user-fixture.js";

interface MockRoute {
  path: string;
  query: Record<string, string>;
  headers?: Record<string, string>;
  status?: number;
  body: unknown;
}

function mockGitHubRequests(t: TestContext, routes: MockRoute[]): () => void {
  let requestIndex = 0;
  const mockFetch: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
    const route = routes[requestIndex];
    assert.ok(route, `Unexpected GitHub request: ${url.toString()}`);
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(url.pathname, route.path);
    assert.deepEqual(Object.fromEntries(url.searchParams), route.query);

    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Accept"), "application/vnd.github+json");
    assert.equal(headers.get("Authorization"), "Bearer fixture-token");
    assert.equal(headers.get("User-Agent"), "github-pixel-stats");
    assert.equal(headers.get("X-GitHub-Api-Version"), "2022-11-28");

    requestIndex += 1;
    const responseInit: ResponseInit = { status: route.status ?? 200, ...(route.headers ? { headers: route.headers } : {}) };
    return new Response(JSON.stringify(route.body), responseInit);
  };
  t.mock.method(globalThis, "fetch", mockFetch);
  return () => assert.equal(requestIndex, routes.length, "Not all registered GitHub responses were requested.");
}

function mockImmediateTimeouts(t: TestContext): number[] {
  const waits: number[] = [];
  t.mock.method(globalThis, "setTimeout", (callback: () => void, delay: number) => {
    waits.push(delay);
    callback();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  return waits;
}

const commitPath = "/repos/example/repo/commits/abc";
const commitQuery = { per_page: "100", page: "1" };

function commitResponse(status: number, headers?: Record<string, string>): MockRoute {
  return { path: commitPath, query: commitQuery, status, ...(headers ? { headers } : {}), body: {} };
}

function successfulCommitResponse(): MockRoute {
  return { path: commitPath, query: commitQuery, body: { files: [] } };
}

function requestCommitFilenames(): Promise<string[]> {
  return new GitHubClient("fixture-token").getCommitFilenames("example/repo", "abc");
}

function pageRoutes(path: string, pages: Array<{ query: Record<string, string>; headers?: Record<string, string>; body: unknown }>): MockRoute[] {
  return pages.map((page) => ({ path, ...page }));
}

function profileRoutes(fixture: GitHubResponsesFixture): MockRoute[] {
  return [
    {
      path: fixture.userProfile.path,
      query: fixture.userProfile.query,
      body: fixture.userProfile.body,
    },
    ...pageRoutes(fixture.ownedRepositories.path, fixture.ownedRepositories.pages),
  ];
}

for (const login of ["other-account", "fixture/alpha"]) {
  test(`profile lookup rejects an invalid GitHub login: ${login}`, async (t) => {
    const assertComplete = mockGitHubRequests(t, [
      { path: "/users/fixture-alpha", query: {}, body: { login, public_repos: 4 } },
    ]);

    await assert.rejects(
      new GitHubClient("fixture-token").getProfileStats("fixture-alpha"),
      /unexpected login|GitHub username/,
    );
    assertComplete();
  });
}

test("profile lookup preserves GitHub login spelling for repository requests", async (t) => {
  const { githubResponses } = await loadUserFixture("fixture-alpha");
  const routes = profileRoutes(githubResponses);
  const profile = routes[0];
  assert.ok(profile);
  const assertComplete = mockGitHubRequests(t, [
    { ...profile, body: { ...githubResponses.userProfile.body, login: "Fixture-Alpha" } },
    ...routes.slice(1).map((route) => ({ ...route, path: route.path.replace("/fixture-alpha/", "/Fixture-Alpha/") })),
  ]);

  const stats = await new GitHubClient("fixture-token").getProfileStats("fixture-alpha");

  assert.equal(stats.login, "Fixture-Alpha");
  assertComplete();
});

for (const fixtureName of USER_FIXTURE_NAMES) {
  test(`${fixtureName} searches commits with the registered pagination`, async (t) => {
    const { githubResponses } = await loadUserFixture(fixtureName);
    const assertComplete = mockGitHubRequests(
      t,
      pageRoutes(githubResponses.searchCommits.path, githubResponses.searchCommits.pages),
    );

    const commits = await new GitHubClient("fixture-token").searchCommits(
      githubResponses.username,
      new Date(githubResponses.period.from),
      new Date(githubResponses.period.to),
    );

    assert.deepEqual(commits, githubResponses.searchCommits.expected);
    assertComplete();
  });

  test(`${fixtureName} collects commit filenames across every page`, async (t) => {
    const { githubResponses } = await loadUserFixture(fixtureName);
    const detail = githubResponses.commitDetails;
    const assertComplete = mockGitHubRequests(t, pageRoutes(detail.path, detail.pages));

    const filenames = await new GitHubClient("fixture-token").getCommitFilenames(detail.repository, detail.sha);

    assert.deepEqual(filenames, detail.expectedFilenames);
    assertComplete();
  });

  test(`${fixtureName} collects public repository and owned star totals`, async (t) => {
    const { githubResponses } = await loadUserFixture(fixtureName);
    const assertComplete = mockGitHubRequests(t, profileRoutes(githubResponses));

    const stats = await new GitHubClient("fixture-token").getProfileStats(githubResponses.username);

    assert.deepEqual(stats, githubResponses.expectedProfileStats);
    assertComplete();
  });
}

for (const status of [403, 429]) {
  for (const headers of [undefined, { "retry-after": " " }, { "retry-after": "invalid" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "" }]) {
    test(`GitHub ${status} without a usable retry hint fails without waiting: ${JSON.stringify(headers)}`, async (t) => {
      const assertComplete = mockGitHubRequests(t, [commitResponse(status, headers)]);
      const waits = mockImmediateTimeouts(t);

      await assert.rejects(requestCommitFilenames(), new RegExp(`GitHub API ${status}`));

      assert.deepEqual(waits, []);
      assertComplete();
    });
  }
}

test("retry-after takes precedence over reset and enforces the minimum wait", async (t) => {
  const assertComplete = mockGitHubRequests(t, [
    commitResponse(429, { "retry-after": "0", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "9999999999" }),
    successfulCommitResponse(),
  ]);
  const waits = mockImmediateTimeouts(t);

  assert.deepEqual(await requestCommitFilenames(), []);

  assert.deepEqual(waits, [1_000]);
  assertComplete();
});

test("retry-after uses seconds and a valid reset is used when retry-after is invalid", async (t) => {
  t.mock.method(Date, "now", () => 1_000_000);
  const assertComplete = mockGitHubRequests(t, [
    commitResponse(403, { "retry-after": "2", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1004" }),
    commitResponse(429, { "retry-after": "invalid", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1004" }),
    successfulCommitResponse(),
  ]);
  const waits = mockImmediateTimeouts(t);

  assert.deepEqual(await requestCommitFilenames(), []);

  assert.deepEqual(waits, [2_000, 5_000]);
  assertComplete();
});

test("rate-limit waits above 60 seconds do not retry", async (t) => {
  t.mock.method(Date, "now", () => 1_000_000);
  const assertComplete = mockGitHubRequests(t, [commitResponse(429, { "retry-after": "61" })]);
  const waits = mockImmediateTimeouts(t);

  await assert.rejects(requestCommitFilenames(), /GitHub API 429/);

  assert.deepEqual(waits, []);
  assertComplete();
});

test("reset waits above 60 seconds do not retry", async (t) => {
  t.mock.method(Date, "now", () => 1_000_000);
  const assertComplete = mockGitHubRequests(t, [
    commitResponse(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1060" }),
  ]);
  const waits = mockImmediateTimeouts(t);

  await assert.rejects(requestCommitFilenames(), /GitHub API 403/);

  assert.deepEqual(waits, []);
  assertComplete();
});

test("other GitHub errors do not retry when rate-limit headers are present", async (t) => {
  const assertComplete = mockGitHubRequests(t, [commitResponse(500, { "retry-after": "1" })]);
  const waits = mockImmediateTimeouts(t);

  await assert.rejects(requestCommitFilenames(), /GitHub API 500/);

  assert.deepEqual(waits, []);
  assertComplete();
});

test("rate-limit failures stop after three retries", async (t) => {
  const assertComplete = mockGitHubRequests(t, Array.from({ length: 4 }, () => commitResponse(429, { "retry-after": "1" })));
  const waits = mockImmediateTimeouts(t);

  await assert.rejects(requestCommitFilenames(), /GitHub API 429/);

  assert.deepEqual(waits, [1_000, 1_000, 1_000]);
  assertComplete();
});
