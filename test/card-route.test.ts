import assert from "node:assert/strict";
import test from "node:test";
import card from "../api/card.js";
import { LANGUAGES_CARD, STATS_CARD } from "../src/config.js";
import { LinguistClassifier } from "../src/data/linguist.js";
import { NEW_USER_LIMIT, NEW_USER_WINDOW_MS, admitUser, markAdmissionFailures, markUserRemoved } from "../src/hosting/admission-policy.js";
import { canonicalCardPath } from "../src/hosting/card-request.js";
import { cardResponse } from "../src/hosting/card-response.js";
import type { CollectionResult } from "../src/model.js";
import { DEFAULT_MASCOT_ID, type MascotId } from "../src/render/index.js";
import { updateAdmissions } from "../src/storage/admissions.js";
import { ADMISSIONS_PATHNAME, manifestPathname, releasePathnames } from "../src/storage/pathnames.js";
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
    metrics: { searchedCommits: 0, cacheHits: 0, fetchedCommits: 0, skippedCommits: 0, removedCommits: 0 },
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
    ["/fixture-alpha/languages.svg", pathnames.languages],
    ["/api/card?__card=stats&__username=fixture-alpha", pathnames.stats[DEFAULT_MASCOT_ID]],
    ["/api/card?__card=languages&__username=fixture-alpha", pathnames.languages],
  ] as const;
  for (const [path, pathname] of cases) {
    const response = await cardResponse(get(path), { privateStore, publicStore });
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("X-Card-Status"), "ready", path);
    assert.equal(response.headers.get("Content-Type"), "image/svg+xml; charset=utf-8", path);
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff", path);
    assert.match(response.headers.get("Content-Security-Policy") ?? "", /default-src 'none'/, path);
    assert.equal(response.headers.get("Cache-Control"), "public, max-age=300", path);
    assert.equal(response.headers.get("Vercel-CDN-Cache-Control"), "max-age=43200, stale-while-revalidate=86400", path);
    assert.equal(await response.text(), publicStore.objects.get(pathname)?.body, path);
  }
});

test("non-canonical card URLs redirect to the canonical path without reading storage", async () => {
  const { privateStore, publicStore } = await publishedStores();
  for (const store of [privateStore, publicStore]) {
    store.read = async () => assert.fail("redirects must not read storage");
  }
  forbidWrites(privateStore, publicStore);
  const cases = [
    ["/Fixture-Alpha/stats.svg", "/fixture-alpha/stats.svg"],
    ["/fixture-alpha/stats.svg?mascot=unknown", "/fixture-alpha/stats.svg"],
    [`/fixture-alpha/stats.svg?mascot=${DEFAULT_MASCOT_ID}`, "/fixture-alpha/stats.svg"],
    ["/fixture-alpha/stats.svg?mascot=", "/fixture-alpha/stats.svg"],
    ["/fixture-alpha/stats.svg?utm=readme", "/fixture-alpha/stats.svg"],
    ["/fixture-alpha/languages.svg?mascot=unknown", "/fixture-alpha/languages.svg"],
    ["/fixture-alpha/stats.svg?username=other&card=languages", "/fixture-alpha/stats.svg"],
    ["/fixture-alpha/stats.svg?card=stats&card=stats", "/fixture-alpha/stats.svg"],
    ["/fixture-alpha/stats.svg?__card=languages", "/fixture-alpha/stats.svg"],
    ["/fixture-alpha/stats.svg?__username=Fixture-Alpha", "/fixture-alpha/stats.svg"],
    ["/api/card?__card=stats&__username=fixture-alpha&username=Fixture-Alpha", "/fixture-alpha/stats.svg"],
    ["/api/card?__card=stats&__username=fixture-alpha&card=languages", "/fixture-alpha/stats.svg"],
    ["/api/card?__card=stats&__username=Fixture-Alpha&mascot=unknown", "/fixture-alpha/stats.svg"],
    ["/api/card?__card=languages&__username=fixture-alpha&x=1", "/fixture-alpha/languages.svg"],
  ] as const;
  for (const [path, location] of cases) {
    for (const method of ["GET", "HEAD"]) {
      const response = await cardResponse(get(path, { method }), { privateStore, publicStore });
      assert.equal(response.status, 308, `${method} ${path}`);
      assert.equal(response.headers.get("Location"), location, `${method} ${path}`);
      assert.equal(response.headers.get("Cache-Control"), "public, max-age=300", path);
      assert.equal(response.headers.get("Vercel-CDN-Cache-Control"), "max-age=86400", path);
      assert.equal(await response.text(), "", path);
    }
  }
});

test("canonical URLs never redirect in either the public or the rewritten form", async () => {
  const { privateStore, publicStore } = await publishedStores();
  const stores = { privateStore, publicStore };
  // rewrite가 원래 query에 destination query를 합쳐 공개 경로 그대로 전달하는 경우도 정규 URL로 봅니다.
  const canonical = [
    "/fixture-alpha/stats.svg",
    "/fixture-alpha/stats.svg?__card=stats&__username=fixture-alpha",
    "/fixture-alpha/stats.svg?__card=stats&__username=fixture-alpha&__username=fixture-alpha",
    "/api/card?__card=stats&__username=fixture-alpha&__username=fixture-alpha",
    "/api/card?__card=stats&__username=fixture-alpha",
    "/api/card?__username=fixture-alpha&__card=languages",
  ];
  for (const path of canonical) {
    const response = await cardResponse(get(path), stores);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("X-Card-Status"), "ready", path);
  }
  // 어떤 비정규 URL도 redirect를 한 번 따라가면 정규 URL에 도달하며, Function이 받는 URL 형태와는 무관합니다.
  const nonCanonical = [
    "/Fixture-Alpha/stats.svg?mascot=unknown&x=1",
    "/api/card?__card=languages&__username=FIXTURE-ALPHA&mascot=cat",
    "/fixture-alpha/stats.svg?username=Fixture-Alpha&card=languages",
  ];
  for (const path of nonCanonical) {
    const location = (await cardResponse(get(path), stores)).headers.get("Location")!;
    const [pathname, query = ""] = location.split("?");
    const [, user, kind] = /^\/([^/]+)\/(stats|languages)\.svg$/.exec(pathname!)!;
    const routing = `__card=${kind}&__username=${user}`;
    const forms = [
      location,
      `${location}${query ? "&" : "?"}${routing}`,
      `/api/card?${routing}${query ? `&${query}` : ""}`,
      `/api/card?${query ? `${query}&` : ""}${routing}`,
    ];
    for (const form of forms) {
      const followed = await cardResponse(get(form), stores);
      assert.equal(followed.status, 200, `${path} -> ${form}`);
      assert.equal(followed.headers.get("X-Card-Status"), "ready", `${path} -> ${form}`);
    }
  }
});

test("redirects come before storage configuration checks and only ever point at a card path", async () => {
  const cases = [
    ["/Fixture-Alpha/stats.svg", "/fixture-alpha/stats.svg"],
    ["/api/card?__card=stats&__username=alice%0D%0A", "/alice/stats.svg"],
    ["/api/card?__card=stats&__username=+alice", "/alice/stats.svg"],
    ["/api/card?__card=languages&__username=%20Alice", "/alice/languages.svg"],
  ] as const;
  for (const [path, location] of cases) {
    const response = await cardResponse(get(path), undefined);
    assert.equal(response.status, 308, path);
    assert.equal(response.headers.get("Location"), location, path);
  }
  for (const path of ["//evil.example/stats.svg", "/api/card?__card=stats&__username=%2F%2Fevil.example"]) {
    const response = await cardResponse(get(path), undefined);
    assert.equal(response.headers.get("Location"), null, path);
  }
});

test("canonical card paths are lowercase and keep only non-default mascot variants", () => {
  // registry에는 기본 마스코트 하나뿐이라, 이후 추가될 preset을 가정한 ID를 cast로 만듭니다.
  const other = "other" as MascotId;
  assert.equal(canonicalCardPath("Fixture-Alpha", { kind: "stats", mascot: DEFAULT_MASCOT_ID }), "/fixture-alpha/stats.svg");
  assert.equal(canonicalCardPath("Fixture-Alpha", { kind: "stats", mascot: other }), "/fixture-alpha/stats.svg?mascot=other");
  assert.equal(canonicalCardPath("fixture-alpha", { kind: "languages" }), "/fixture-alpha/languages.svg");
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

test("query values that conflict with each other never select another card", async () => {
  const { privateStore, publicStore } = await publishedStores();
  const stores = { privateStore, publicStore };
  const ambiguousUser = await cardResponse(get("/api/card?__card=stats&__username=fixture-alpha&__username=other"), stores);
  assert.equal(ambiguousUser.headers.get("X-Card-Status"), "invalid-username");
  const ambiguousCard = await cardResponse(get("/api/card?__card=stats&__card=languages&__username=fixture-alpha"), stores);
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
    assert.equal(response.headers.get("Vercel-CDN-Cache-Control"), null, path);
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
      ["/Fixture-Beta/languages.svg", empty, null],
      ["/fixture-beta/languages.svg", empty, "pending"],
    ] as const;
    for (const [path, stores, status] of cases) {
      const response = await cardResponse(get(path), stores, { onPending });
      assert.equal(response.headers.get("X-Card-Status"), status, path);
    }
    assert.deepEqual(calls, ["fixture-beta"]);

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
  for (const path of ["/bad--name/stats.svg", "/%3Cscript%3E/stats.svg", "/api/card?__card=stats", "/api/card?__card=stats&__username=-x"]) {
    const response = await cardResponse(get(path), stores);
    assert.equal(response.headers.get("X-Card-Status"), "invalid-username", path);
    assert.equal(response.headers.get("Cache-Control"), "public, max-age=300", path);
    assert.equal(response.headers.get("Vercel-CDN-Cache-Control"), "max-age=86400", path);
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
      assert.equal(response.headers.get("Vercel-CDN-Cache-Control"), null);
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
  const unknown = await cardResponse(get("/api/card?__card=other&__username=fixture-alpha"), stores);
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

test("unpublished users receive a status from the admission record without any write", async () => {
  const now = new Date("2026-10-01T00:00:00.000Z");
  const privateStore = new MemoryObjectStore("private");
  const publicStore = new MemoryObjectStore("public");
  await updateAdmissions(privateStore, (current) => {
    let next = admitUser(current, "ghost", now)!;
    next = markAdmissionFailures(next, ["ghost"], now)!;
    for (let index = 1; index < NEW_USER_LIMIT; index += 1) next = admitUser(next, `user${index}`, now)!;
    // 삭제 표시는 상한에 세지 않으므로 신규 등록 5명 상한이 그대로 `capacity`를 만듭니다.
    return markUserRemoved(next, "gone", now)!;
  });
  forbidWrites(privateStore, publicStore);
  const stores = { privateStore, publicStore };
  const calls: string[] = [];
  const options = { now: () => now, onPending: (username: string) => { calls.push(username); } };
  const cases = [
    ["/user1/stats.svg", "pending", "no-store", null, /PREPARING/, STATS_CARD],
    ["/ghost/stats.svg", "failed", "no-store", "max-age=3600", /NO STATS/, STATS_CARD],
    ["/ghost/languages.svg", "failed", "no-store", "max-age=3600", /NO STATS/, LANGUAGES_CARD],
    ["/new-user/stats.svg", "capacity", "no-store", "max-age=600", /AT CAPACITY/, STATS_CARD],
    ["/new-user/languages.svg", "capacity", "no-store", "max-age=600", /AT CAPACITY/, LANGUAGES_CARD],
    ["/gone/stats.svg", "removed", "no-store", "max-age=3600", /REMOVED/, STATS_CARD],
    ["/gone/languages.svg", "removed", "no-store", "max-age=3600", /REMOVED/, LANGUAGES_CARD],
  ] as const;
  for (const [path, status, cacheControl, cdn, text, size] of cases) {
    const response = await cardResponse(get(path), stores, options);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("X-Card-Status"), status, path);
    assert.equal(response.headers.get("Cache-Control"), cacheControl, path);
    assert.equal(response.headers.get("Vercel-CDN-Cache-Control"), cdn, path);
    const svg = await response.text();
    assertSvg(svg, path, size.width, size.height);
    assert.match(svg, text, path);
  }
  assert.deepEqual(calls, ["user1"]);

  for (const path of ["/ghost/stats.svg", "/new-user/stats.svg"]) {
    const head = await cardResponse(get(path, { method: "HEAD" }), stores, options);
    assert.equal(head.status, 200, path);
    assert.notEqual(head.headers.get("Vercel-CDN-Cache-Control"), null, path);
    assert.equal(await head.text(), "", path);
  }
  assert.deepEqual(calls, ["user1"]);

  // 24시간이 지나 신규 등록 상한에 여유가 생기면 새 사용자도 pending으로 bootstrap을 예약합니다.
  const later = new Date(now.getTime() + NEW_USER_WINDOW_MS);
  const response = await cardResponse(get("/new-user/stats.svg"), stores, { ...options, now: () => later });
  assert.equal(response.headers.get("X-Card-Status"), "pending");
  assert.deepEqual(calls, ["user1", "new-user"]);
});

test("a corrupted admission record returns an unavailable card without scheduling bootstrap", async () => {
  const privateStore = new MemoryObjectStore("private");
  const publicStore = new MemoryObjectStore("public");
  privateStore.objects.set(ADMISSIONS_PATHNAME, {
    body: "{", etag: '"x"', uploadedAt: new Date(), contentType: "application/json", cacheControlMaxAge: 60,
  });
  const originalError = console.error;
  console.error = () => {};
  const calls: string[] = [];
  try {
    const response = await cardResponse(get("/new-user/stats.svg"), { privateStore, publicStore }, {
      onPending: (username) => { calls.push(username); },
    });
    assert.equal(response.headers.get("X-Card-Status"), "unavailable");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(calls, []);
  } finally {
    console.error = originalError;
  }
});

test("published users receive their card regardless of the admission record", async () => {
  const now = new Date("2026-10-01T00:00:00.000Z");
  const failedMark = await publishedStores();
  await updateAdmissions(failedMark.privateStore, (current) => markAdmissionFailures(admitUser(current, "fixture-alpha", now)!, ["fixture-alpha"], now));
  const full = await publishedStores();
  await updateAdmissions(full.privateStore, (current) => {
    let next = current;
    for (let index = 0; index < NEW_USER_LIMIT; index += 1) next = admitUser(next, `user${index}`, now)!;
    return next;
  });
  const corrupted = await publishedStores();
  corrupted.privateStore.objects.set(ADMISSIONS_PATHNAME, {
    body: "{", etag: '"x"', uploadedAt: now, contentType: "application/json", cacheControlMaxAge: 60,
  });
  const calls: string[] = [];
  for (const [label, stores] of [["failed mark", failedMark], ["capacity", full], ["corrupted", corrupted]] as const) {
    forbidWrites(stores.privateStore, stores.publicStore);
    const response = await cardResponse(get("/fixture-alpha/stats.svg"), stores, {
      now: () => now,
      onPending: (username) => { calls.push(username); },
    });
    assert.equal(response.headers.get("X-Card-Status"), "ready", label);
    assert.equal(response.headers.get("Vercel-CDN-Cache-Control"), "max-age=43200, stale-while-revalidate=86400", label);
  }
  assert.deepEqual(calls, []);
});
