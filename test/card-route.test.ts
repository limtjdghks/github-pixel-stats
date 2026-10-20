import assert from "node:assert/strict";
import test from "node:test";
import card from "../api/card.js";
import { LANGUAGES_CARD, STATS_CARD } from "../src/config.js";
import { LinguistClassifier } from "../src/data/linguist.js";
import { cardResponse } from "../src/hosting/card-response.js";
import type { CollectionResult } from "../src/model.js";
import { DEFAULT_MASCOT_ID, type MascotId } from "../src/render/index.js";
import { manifestPathname, releasePathnames } from "../src/storage/pathnames.js";
import { publishRelease } from "../src/storage/publish.js";
import { selectReleaseMascot } from "../src/storage/published-card.js";
import { assertSvg } from "../src/validation/output.js";
import { loadUserFixture } from "./helpers/load-user-fixture.js";
import { MemoryObjectStore } from "./helpers/memory-object-store.js";

const classifierPromise = LinguistClassifier.loadDefault();
const fixturePromise = loadUserFixture("fixture-alpha");

async function result(minutesLater = 0): Promise<CollectionResult> {
  const { snapshot, state } = structuredClone(await fixturePromise);
  snapshot.generatedAt = new Date(Date.parse(snapshot.generatedAt) + minutesLater * 60_000).toISOString();
  return {
    snapshot, nextState: state, stateChanged: true,
    metrics: { searchedCommits: 0, cacheHits: 0, fetchedCommits: 0, removedCommits: 0 },
  };
}

/** 발행 횟수만큼 1분씩 늦은 snapshot을 발행해 두 번째부터 previous release가 생기게 합니다. */
async function publishedStores(releases = 1) {
  const now = () => new Date("2026-10-01T00:00:00.000Z");
  const privateStore = new MemoryObjectStore("private", now);
  const publicStore = new MemoryObjectStore("public", now);
  const classifier = await classifierPromise;
  const versions: string[] = [];
  for (let index = 0; index < releases; index += 1) {
    const outcome = await publishRelease(await result(index), { privateStore, publicStore, classifier, now });
    assert.ok(outcome.status === "published");
    versions.push(outcome.manifest.current.version);
  }
  return { privateStore, publicStore, versions };
}

/** 카드 요청은 읽기 전용이어야 하므로 쓰기·삭제를 호출하면 실패시킵니다. */
function forbidWrites(...stores: MemoryObjectStore[]): void {
  for (const store of stores) {
    store.write = async () => assert.fail("card requests must not write");
    store.delete = async () => assert.fail("card requests must not delete");
  }
}

function get(path: string, init?: RequestInit): Request {
  return new Request(`https://example.test${path}`, init);
}

test("published users receive the current release card from the public store", async () => {
  const { privateStore, publicStore, versions } = await publishedStores();
  forbidWrites(privateStore, publicStore);
  const pathnames = releasePathnames("fixture-alpha", versions[0]!, [DEFAULT_MASCOT_ID]).public;
  const cases = [
    ["/fixture-alpha/stats.svg", pathnames.stats[DEFAULT_MASCOT_ID]],
    ["/Fixture-Alpha/stats.svg?mascot=unknown", pathnames.stats[DEFAULT_MASCOT_ID]],
    [`/fixture-alpha/stats.svg?mascot=${DEFAULT_MASCOT_ID}`, pathnames.stats[DEFAULT_MASCOT_ID]],
    ["/fixture-alpha/languages.svg?mascot=unknown", pathnames.languages],
    ["/api/card?card=stats&username=fixture-alpha", pathnames.stats[DEFAULT_MASCOT_ID]],
    ["/api/card?card=languages&username=fixture-alpha", pathnames.languages],
  ] as const;
  for (const [path, pathname] of cases) {
    const response = await cardResponse(get(path), { privateStore, publicStore });
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("X-Card-Status"), "ready", path);
    assert.equal(response.headers.get("Content-Type"), "image/svg+xml; charset=utf-8", path);
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff", path);
    assert.match(response.headers.get("Content-Security-Policy") ?? "", /default-src 'none'/, path);
    assert.equal(response.headers.get("Cache-Control"), "public, max-age=300", path);
    assert.equal(await response.text(), publicStore.objects.get(pathname)?.body, path);
  }
});

test("a missing current card falls back to the previous successful release", async () => {
  const { privateStore, publicStore, versions } = await publishedStores(2);
  const [previous, current] = versions.map((version) => releasePathnames("fixture-alpha", version!, [DEFAULT_MASCOT_ID]).public);
  publicStore.objects.delete(current!.stats[DEFAULT_MASCOT_ID]);
  forbidWrites(privateStore, publicStore);

  const response = await cardResponse(get("/fixture-alpha/stats.svg"), { privateStore, publicStore });
  assert.equal(response.headers.get("X-Card-Status"), "ready");
  assert.equal(await response.text(), publicStore.objects.get(previous!.stats[DEFAULT_MASCOT_ID])?.body);
});

test("query values that conflict with the path or each other never select another card", async () => {
  const { privateStore, publicStore, versions } = await publishedStores();
  const stores = { privateStore, publicStore };
  const pathnames = releasePathnames("fixture-alpha", versions[0]!, [DEFAULT_MASCOT_ID]).public;
  const ready = [
    ["/fixture-alpha/stats.svg?username=other&card=languages", pathnames.stats[DEFAULT_MASCOT_ID]],
    ["/api/card?card=stats&username=fixture-alpha&username=fixture-alpha", pathnames.stats[DEFAULT_MASCOT_ID]],
  ] as const;
  for (const [path, pathname] of ready) {
    const response = await cardResponse(get(path), stores);
    assert.equal(response.headers.get("X-Card-Status"), "ready", path);
    assert.equal(await response.text(), publicStore.objects.get(pathname)?.body, path);
  }
  const ambiguousUser = await cardResponse(get("/api/card?card=stats&username=fixture-alpha&username=other"), stores);
  assert.equal(ambiguousUser.headers.get("X-Card-Status"), "invalid-username");
  const ambiguousCard = await cardResponse(get("/api/card?card=stats&card=languages&username=fixture-alpha"), stores);
  assert.equal(ambiguousCard.status, 404);
});

test("stats mascot selection prefers the request, then the default, then the release's first mascot", () => {
  // registry에는 기본 마스코트 하나뿐이라, 이후 추가되거나 기본값이 바뀐 상황을 가정한 ID를 cast로 만듭니다.
  const other = "other" as MascotId;
  const release = (mascots: MascotId[]) => ({ version: "20261001-000000-0123456789abcdef", generatedAt: "2026-10-01T00:00:00.000Z", mascots });
  assert.equal(selectReleaseMascot(release([DEFAULT_MASCOT_ID, other]), other), other);
  assert.equal(selectReleaseMascot(release([DEFAULT_MASCOT_ID]), other), DEFAULT_MASCOT_ID);
  assert.equal(selectReleaseMascot(release([other]), DEFAULT_MASCOT_ID), other);
  assert.equal(selectReleaseMascot(release([]), DEFAULT_MASCOT_ID), undefined);
});

test("a current release without any registered mascot serves the previous stats card", async () => {
  const { privateStore, publicStore, versions } = await publishedStores(2);
  const [previous, current] = versions.map((version) => releasePathnames("fixture-alpha", version!, [DEFAULT_MASCOT_ID]).public);
  const manifest = privateStore.objects.get(manifestPathname("fixture-alpha"))!;
  const parsed = JSON.parse(manifest.body) as { current: { mascots: string[] } };
  // registry에서 제거된 마스코트만 가진 release는 manifest를 읽을 때 빈 목록이 됩니다.
  parsed.current.mascots = ["retired-mascot"];
  manifest.body = JSON.stringify(parsed);
  const stores = { privateStore, publicStore };

  const stats = await cardResponse(get("/fixture-alpha/stats.svg"), stores);
  assert.equal(await stats.text(), publicStore.objects.get(previous!.stats[DEFAULT_MASCOT_ID])?.body);
  const languages = await cardResponse(get("/fixture-alpha/languages.svg"), stores);
  assert.equal(await languages.text(), publicStore.objects.get(current!.languages)?.body);
});

test("users without a manifest receive a pending card and nothing is written", async () => {
  const privateStore = new MemoryObjectStore("private");
  const publicStore = new MemoryObjectStore("public");
  forbidWrites(privateStore, publicStore);
  for (const [path, size] of [["/new-user/stats.svg", STATS_CARD], ["/new-user/languages.svg", LANGUAGES_CARD]] as const) {
    const response = await cardResponse(get(path), { privateStore, publicStore });
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("X-Card-Status"), "pending", path);
    assert.equal(response.headers.get("Cache-Control"), "no-store", path);
    const svg = await response.text();
    assertSvg(svg, path, size.width, size.height);
    assert.match(svg, /PREPARING/);
  }
  assert.deepEqual(privateStore.pathnames(), []);
  assert.deepEqual(publicStore.pathnames(), []);
});

test("only pending responses invoke the pending hook, and a failing hook keeps the pending card", async () => {
  const published = await publishedStores();
  const failingRead = await publishedStores();
  failingRead.publicStore.read = async () => { throw new Error("network down"); };
  const empty = { privateStore: new MemoryObjectStore("private"), publicStore: new MemoryObjectStore("public") };
  const calls: string[] = [];
  const onPending = (username: string) => { calls.push(username); };
  const originalError = console.error;
  console.error = () => {};
  try {
    const cases = [
      ["/fixture-alpha/stats.svg", published, "ready"],
      ["/bad--name/stats.svg", empty, "invalid-username"],
      ["/fixture-alpha/stats.svg", undefined, "unavailable"],
      ["/fixture-alpha/stats.svg", failingRead, "unavailable"],
      ["/Fixture-Beta/languages.svg", empty, "pending"],
    ] as const;
    for (const [path, stores, status] of cases) {
      const response = await cardResponse(get(path), stores, { onPending });
      assert.equal(response.headers.get("X-Card-Status"), status, path);
    }
    assert.deepEqual(calls, ["Fixture-Beta"]);

    const failing = await cardResponse(get("/fixture-beta/stats.svg"), empty, {
      onPending: () => { throw new Error("schedule failed"); },
    });
    assert.equal(failing.status, 200);
    assert.equal(failing.headers.get("X-Card-Status"), "pending");
  } finally {
    console.error = originalError;
  }
});

test("invalid usernames receive the same status card without reflecting the input", async () => {
  const stores = { privateStore: new MemoryObjectStore("private"), publicStore: new MemoryObjectStore("public") };
  const bodies = new Set<string>();
  for (const path of ["/bad--name/stats.svg", "/%3Cscript%3E/stats.svg", "/api/card?card=stats", "/api/card?card=stats&username=-x"]) {
    const response = await cardResponse(get(path), stores);
    assert.equal(response.headers.get("X-Card-Status"), "invalid-username", path);
    const svg = await response.text();
    assertSvg(svg, path, STATS_CARD.width, STATS_CARD.height);
    assert.equal(svg.includes("bad--name") || svg.includes("script"), false, path);
    bodies.add(svg);
  }
  assert.equal(bodies.size, 1);
});

test("storage failures and missing stores return an unavailable card instead of an error", async () => {
  const corrupted = await publishedStores();
  corrupted.privateStore.objects.get(manifestPathname("fixture-alpha"))!.body = "{";
  const missingCards = await publishedStores();
  missingCards.publicStore.objects.clear();
  const failingRead = await publishedStores();
  failingRead.publicStore.read = async () => { throw new Error("network down"); };

  const originalError = console.error;
  console.error = () => {};
  try {
    for (const stores of [corrupted, missingCards, failingRead, undefined]) {
      const response = await cardResponse(get("/fixture-alpha/languages.svg"), stores);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("X-Card-Status"), "unavailable");
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assertSvg(await response.text(), "unavailable", LANGUAGES_CARD.width, LANGUAGES_CARD.height);
    }
  } finally {
    console.error = originalError;
  }
});

test("storage reads that exceed the time budget return an unavailable card", async () => {
  const { privateStore, publicStore } = await publishedStores();
  let receivedSignal: AbortSignal | undefined;
  // signal을 무시하고 끝나지 않는 읽기도 예산 안에 응답해야 합니다.
  publicStore.read = (_pathname, signal) => {
    receivedSignal = signal;
    return new Promise(() => {});
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    const response = await cardResponse(get("/fixture-alpha/stats.svg"), { privateStore, publicStore }, { timeoutMs: 20 });
    assert.equal(response.headers.get("X-Card-Status"), "unavailable");
    assert.equal(receivedSignal?.aborted, true);
  } finally {
    console.error = originalError;
  }
});

test("card route rejects unknown cards and methods and omits HEAD bodies", async () => {
  const { privateStore, publicStore } = await publishedStores();
  const stores = { privateStore, publicStore };
  const head = await cardResponse(get("/fixture-alpha/stats.svg", { method: "HEAD" }), stores);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("X-Card-Status"), "ready");
  assert.equal(await head.text(), "");
  const post = await cardResponse(get("/fixture-alpha/stats.svg", { method: "POST" }), stores);
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("Allow"), "GET, HEAD");
  const unknown = await cardResponse(get("/api/card?card=other&username=fixture-alpha"), stores);
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { status: "not_found" });
});

test("card function without Blob store configuration answers without external requests", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    throw new Error("Unexpected external request");
  };
  try {
    const response = await card.fetch(get("/example/stats.svg"));
    assert.equal(response.headers.get("X-Card-Status"), "unavailable");
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
