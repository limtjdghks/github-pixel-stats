import assert from "node:assert/strict";
import test from "node:test";
import { GitHubClient } from "../src/data/github-client.js";
import {
  GitHubRequestError,
  GitHubRestPageSource,
  getRateLimitDelay,
  isUnavailableCommitDetail,
  splitSearchInterval,
  type PageRequest,
} from "../src/data/github-pages.js";

const filesRequest: PageRequest = { kind: "files", repository: "example/repo", sha: "abc", page: 1 };

test("page source performs one request and exposes retry metadata without retrying", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    return new Response("{}", { status: 429, headers: { "retry-after": "2" } });
  });
  await assert.rejects(
    new GitHubRestPageSource("fixture-token").requestPage(filesRequest, new AbortController().signal),
    (error: unknown) => {
      assert.ok(error instanceof GitHubRequestError);
      assert.equal(error.retryDelayMs, 2_000);
      assert.equal(error.status, 429);
      return true;
    },
  );
  assert.equal(requests, 1);
});

test("a 403 or 429 without wait headers waits a minute only when its body reports a rate limit", async (t) => {
  // 헤더 없는 secondary rate limit을 권한 거부로 보면 커밋 상세를 건너뛰어 언어 없는 결과가 cache됩니다.
  const cases: Array<[number, string, number | null]> = [
    [403, JSON.stringify({ message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." }), 60_000],
    [429, JSON.stringify({ message: "API rate limit exceeded for user ID 1." }), 60_000],
    [403, JSON.stringify({ message: "The 'Org' organization forbids access via a fine-grained personal access tokens if the token's lifetime is greater than 366 days." }), null],
    [403, "not json", null],
    [404, JSON.stringify({ message: "rate limit" }), null],
  ];
  let next = cases[0]!;
  t.mock.method(globalThis, "fetch", async () => new Response(next[1], { status: next[0] }));
  for (const testCase of cases) {
    next = testCase;
    const [status, body, delay] = testCase;
    await assert.rejects(
      new GitHubRestPageSource("fixture-token").requestPage(filesRequest, new AbortController().signal),
      (error: unknown) => {
        assert.ok(error instanceof GitHubRequestError);
        assert.equal(error.retryDelayMs, delay, `${status} ${body}`);
        assert.equal(isUnavailableCommitDetail(error), delay === null && status !== 429, `${status} ${body}`);
        return true;
      },
    );
  }
});

test("network failures become retryable request errors while cancellation stays a cancellation", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("fetch failed"); });
  await assert.rejects(
    new GitHubRestPageSource("fixture-token").requestPage(filesRequest, new AbortController().signal),
    (error: unknown) => {
      assert.ok(error instanceof GitHubRequestError);
      assert.equal(error.status, undefined);
      assert.equal(error.retryDelayMs, null);
      assert.ok(error.cause instanceof TypeError);
      return true;
    },
  );
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async () => {
    controller.abort(new Error("deadline"));
    throw new DOMException("aborted", "AbortError");
  });
  await assert.rejects(
    new GitHubRestPageSource("fixture-token").requestPage(filesRequest, controller.signal),
    /deadline/,
  );
});

test("rate-limit metadata applies only to throttling and honors reset fallback", () => {
  assert.equal(getRateLimitDelay(new Response("", { status: 500, headers: { "retry-after": "1" } }), 0), null);
  assert.equal(getRateLimitDelay(new Response("", { status: 403, headers: {
    "retry-after": "invalid", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "10",
  } }), 5_000), 6_000);
  assert.equal(getRateLimitDelay(new Response("", { status: 429, headers: {
    "retry-after": "0", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "10",
  } }), 5_000), 1_000);
});

test("only non-throttling 403, 404, and 451 make a commit detail unavailable", () => {
  for (const status of [403, 404, 451]) {
    assert.equal(isUnavailableCommitDetail(new GitHubRequestError(`GitHub API ${status}`, null, status)), true, String(status));
  }
  assert.equal(isUnavailableCommitDetail(new GitHubRequestError("rate limited", 1_000, 403)), false);
  for (const status of [401, 409, 422, 500, undefined]) {
    assert.equal(isUnavailableCommitDetail(new GitHubRequestError("GitHub API error", null, status)), false, String(status));
  }
  assert.equal(isUnavailableCommitDetail(new Error("GitHub API 403")), false);
});

test("page source passes the cancellation signal to fetch", async (t) => {
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    assert.equal(init?.signal, controller.signal);
    return new Response(JSON.stringify({ files: [] }));
  });
  assert.deepEqual(await new GitHubClient("fixture-token").requestPage(filesRequest, controller.signal), {
    kind: "files", filenames: [], fileCount: 0, hasNext: false,
  });
});

test("page source does not start an already cancelled request", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () => new Response("{}"));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(new GitHubRestPageSource("fixture-token").requestPage(filesRequest, controller.signal), { name: "AbortError" });
  assert.equal(mock.mock.callCount(), 0);
});

test("page source propagates cancellation while response JSON is consumed", async (t) => {
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async () => {
    const response = new Response("{}");
    t.mock.method(response, "json", async () => {
      controller.abort();
      return { files: [] };
    });
    return response;
  });
  await assert.rejects(new GitHubRestPageSource("fixture-token").requestPage(filesRequest, controller.signal), { name: "AbortError" });
});

test("page source preserves canonical login and does not fetch repositories", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ login: "Fixture-Alpha", public_repos: 4 })));
  assert.deepEqual(await new GitHubRestPageSource("fixture-token").requestPage(
    { kind: "profile", username: "fixture-alpha" }, new AbortController().signal,
  ), { kind: "profile", login: "Fixture-Alpha", publicRepositories: 4 });
  assert.equal(mock.mock.callCount(), 1);
});

test("file pages expose original file count separately from renamed filenames", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    files: [{ filename: "new.ts", previous_filename: "old.ts" }, { filename: "main.ts" }],
  }), { headers: { link: '<https://api.github.com/page2>; rel="next"' } }));
  assert.deepEqual(await new GitHubRestPageSource("fixture-token").requestPage(filesRequest, new AbortController().signal), {
    kind: "files", filenames: ["new.ts", "old.ts", "main.ts"], fileCount: 2, hasNext: true,
  });
});

test("legacy file collection still rejects the 3000-file limit even without a next page", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    files: Array.from({ length: 3_000 }, (_, index) => ({ filename: `file-${index}.ts` })),
  })));
  await assert.rejects(new GitHubClient("fixture-token").getCommitFilenames("example/repo", "abc"), /3,000-file/);
});

test("incomplete searches preserve metadata and discard unusable partial items", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    total_count: 1, incomplete_results: true, items: [{ commit: { author: null } }],
  })));
  assert.deepEqual(await new GitHubRestPageSource("fixture-token").requestPage(
    { kind: "search", username: "fixture-alpha", from: 0, to: 10_000, page: 1 }, new AbortController().signal,
  ), { kind: "search", commits: [], totalCount: 1, incomplete: true, hasNext: false });
});

test("shared search splitting preserves non-overlapping second boundaries and narrow-range guard", () => {
  assert.deepEqual(splitSearchInterval(0, 10_000), [{ from: 0, to: 5_000 }, { from: 6_000, to: 10_000 }]);
  assert.throws(() => splitSearchInterval(0, 1_000), /one-second range/);
});
