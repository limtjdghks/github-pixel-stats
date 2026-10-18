import assert from "node:assert/strict";
import test from "node:test";
import { LinguistClassifier } from "../src/data/linguist.js";
import type { CollectionResult } from "../src/model.js";
import { MASCOT_IDS } from "../src/render/index.js";
import type { ObjectStore } from "../src/storage/object-store.js";
import { manifestPathname, releasePathnames } from "../src/storage/pathnames.js";
import { loadPublishedState, readManifest } from "../src/storage/private-repository.js";
import { removeUnreferencedReleases } from "../src/storage/cleanup.js";
import { publishRelease, type PublishDependencies } from "../src/storage/publish.js";
import { loadUserFixture } from "./helpers/load-user-fixture.js";
import { MemoryObjectStore } from "./helpers/memory-object-store.js";

const HOUR = 60 * 60 * 1000;
const classifierPromise = LinguistClassifier.loadDefault();
const fixturePromise = loadUserFixture("fixture-alpha");

/** generatedAt만 바꾼 수집 결과입니다. 기간과 commit은 같으므로 같은 검증을 통과합니다. */
async function result(minutesLater = 0): Promise<CollectionResult> {
  const { snapshot, state } = structuredClone(await fixturePromise);
  snapshot.generatedAt = new Date(Date.parse(snapshot.generatedAt) + minutesLater * 60_000).toISOString();
  return {
    snapshot, nextState: state, stateChanged: true,
    metrics: { searchedCommits: 0, cacheHits: 0, fetchedCommits: 0, removedCommits: 0 },
  };
}

async function setup() {
  const clock = { now: Date.parse("2026-10-01T00:00:00.000Z") };
  const now = () => new Date(clock.now);
  const privateStore = new MemoryObjectStore("private", now);
  const publicStore = new MemoryObjectStore("public", now);
  const dependencies: PublishDependencies = { privateStore, publicStore, classifier: await classifierPromise, now };
  return { clock, privateStore, publicStore, dependencies };
}

function snapshotOf(store: MemoryObjectStore): string {
  return JSON.stringify([...store.objects].map(([pathname, object]) => [pathname, object.etag]).sort());
}

test("publishing stores state privately, cards publicly, and points the manifest at them", async () => {
  const { privateStore, publicStore, dependencies } = await setup();
  const outcome = await publishRelease(await result(), dependencies);
  assert.equal(outcome.status, "published");
  assert.ok(outcome.status === "published");
  assert.equal(outcome.manifest.previous, null);
  assert.deepEqual(outcome.manifest.current.mascots, MASCOT_IDS);

  const pathnames = releasePathnames("fixture-alpha", outcome.manifest.current.version, MASCOT_IDS);
  assert.deepEqual(publicStore.pathnames(), [pathnames.public.languages, ...Object.values(pathnames.public.stats)].sort());
  for (const object of publicStore.objects.values()) {
    assert.match(object.body, /^<svg /);
    assert.equal(object.contentType, "image/svg+xml; charset=utf-8");
    assert.equal(object.cacheControlMaxAge, 31_536_000);
  }
  assert.deepEqual(privateStore.pathnames(), [manifestPathname("fixture-alpha"), pathnames.private.snapshot, pathnames.private.state].sort());
  assert.ok([...privateStore.objects.values()].every((object) => !object.body.includes("<svg")));

  const loaded = await loadPublishedState(privateStore, "Fixture-Alpha");
  assert.deepEqual(loaded, { state: (await fixturePromise).state, cacheUsable: true });
});

test("missing manifests are a cache miss for the next collection", async () => {
  const { privateStore } = await setup();
  assert.deepEqual(await loadPublishedState(privateStore, "fixture-alpha"), { state: null, cacheUsable: false });
});

test("republishing the same result is unchanged and a newer result keeps the previous release", async () => {
  const { clock, dependencies } = await setup();
  const first = await publishRelease(await result(), dependencies);
  assert.equal((await publishRelease(await result(), dependencies)).status, "unchanged");
  clock.now += 60_000;
  const second = await publishRelease(await result(10), dependencies);
  assert.ok(first.status === "published" && second.status === "published");
  assert.deepEqual(second.manifest.previous, first.manifest.current);
  assert.notEqual(second.manifest.current.version, first.manifest.current.version);
});

test("invalid output is rejected before any write and keeps the last successful card", async () => {
  const { privateStore, publicStore, dependencies } = await setup();
  await publishRelease(await result(), dependencies);
  const before = [snapshotOf(privateStore), snapshotOf(publicStore)];
  const broken = await result(10);
  broken.snapshot.stats.stars = -1;
  await assert.rejects(publishRelease(broken, dependencies), /invalid stars/);
  assert.deepEqual([snapshotOf(privateStore), snapshotOf(publicStore)], before);
});

test("a failed card upload leaves the manifest on the last successful release", async () => {
  const { privateStore, publicStore, dependencies } = await setup();
  const first = await publishRelease(await result(), dependencies);
  const failing: ObjectStore = Object.assign(Object.create(publicStore) as ObjectStore, {
    write: async () => { throw new Error("upload failed"); },
  });
  await assert.rejects(publishRelease(await result(10), { ...dependencies, publicStore: failing }), /upload failed/);
  assert.ok(first.status === "published");
  assert.deepEqual((await readManifest(privateStore, "fixture-alpha"))?.manifest, first.manifest);
});

test("a manifest conflict re-reads the manifest and an older snapshot never replaces a newer one", async () => {
  const { privateStore, dependencies } = await setup();
  const newer = await result(30);
  let raced = false;
  // 첫 manifest 쓰기 직전에 더 새로운 발행을 끼워 넣어 ETag 충돌을 만듭니다.
  const racing: ObjectStore = Object.assign(Object.create(privateStore) as ObjectStore, {
    write: async (...args: Parameters<ObjectStore["write"]>) => {
      if (!raced && args[0] === manifestPathname("fixture-alpha")) {
        raced = true;
        await publishRelease(newer, dependencies);
      }
      return privateStore.write(...args);
    },
  });
  const older = await publishRelease(await result(10), { ...dependencies, privateStore: racing });
  assert.equal(older.status, "stale");
  const stored = await readManifest(privateStore, "fixture-alpha");
  assert.equal(stored?.manifest.current.generatedAt, newer.snapshot.generatedAt);
  assert.equal(stored?.manifest.previous, null);
});

test("concurrent publishes always end on the newest snapshot", async () => {
  for (const order of [[10, 20], [20, 10]]) {
    const { privateStore, dependencies } = await setup();
    const results = await Promise.all(order.map(async (minutes) => publishRelease(await result(minutes), dependencies)));
    assert.ok(results.some((outcome) => outcome.status === "published"));
    const stored = await readManifest(privateStore, "fixture-alpha");
    assert.equal(stored?.manifest.current.generatedAt, (await result(20)).snapshot.generatedAt);
  }
});

test("persistent manifest conflicts give up without replacing the last successful manifest", async () => {
  const { privateStore, dependencies } = await setup();
  const first = await publishRelease(await result(), dependencies);
  const conflicting: ObjectStore = Object.assign(Object.create(privateStore) as ObjectStore, {
    write: async (...args: Parameters<ObjectStore["write"]>) =>
      args[0] === manifestPathname("fixture-alpha") ? null : privateStore.write(...args),
  });
  assert.deepEqual(await publishRelease(await result(10), { ...dependencies, privateStore: conflicting }), { status: "conflict" });
  assert.ok(first.status === "published");
  assert.deepEqual((await readManifest(privateStore, "fixture-alpha"))?.manifest, first.manifest);
});

test("cleanup keeps releases until their retirement grace ends, even when they were uploaded long ago", async () => {
  const { clock, privateStore, publicStore, dependencies } = await setup();
  const paths = (outcome: Awaited<ReturnType<typeof publishRelease>>) => {
    assert.ok(outcome.status === "published");
    return releasePathnames("fixture-alpha", outcome.manifest.current.version, MASCOT_IDS);
  };
  const exists = (release: ReturnType<typeof paths>) =>
    publicStore.objects.has(release.public.languages) && privateStore.objects.has(release.private.state);
  const v1 = paths(await publishRelease(await result(), dependencies));
  clock.now += 2 * HOUR;
  const v2 = paths(await publishRelease(await result(10), dependencies));
  clock.now += 60_000;
  const third = await publishRelease(await result(20), dependencies);
  paths(third);
  assert.deepEqual(third.status === "published" && third.cleanup, { deleted: 0 },
    "v1 was uploaded two hours ago but stopped being previous only now");
  assert.ok(exists(v1));

  clock.now += HOUR + 60_000;
  const fourth = await publishRelease(await result(30), dependencies);
  paths(fourth);
  assert.deepEqual(fourth.status === "published" && fourth.cleanup, { deleted: 2 + 1 + MASCOT_IDS.length });
  assert.equal(exists(v1), false);
  assert.ok(exists(v2), "v2 was retired just now and stays during its grace period");
});

test("cleanup also keeps what the latest stored manifest references", async () => {
  const { clock, privateStore, publicStore, dependencies } = await setup();
  const first = await publishRelease(await result(), dependencies);
  clock.now += 2 * HOUR;
  const second = await publishRelease(await result(10), dependencies);
  assert.ok(first.status === "published" && second.status === "published");
  clock.now += 2 * HOUR;
  // 오래된 manifest로 정리를 실행해도, 저장된 최신 manifest가 가리키는 release는 지우지 않습니다.
  const report = await removeUnreferencedReleases({ private: privateStore, public: publicStore }, first.manifest, new Date(clock.now));
  assert.deepEqual(report, { deleted: 0 });
  const latest = releasePathnames("fixture-alpha", second.manifest.current.version, MASCOT_IDS);
  assert.ok(publicStore.objects.has(latest.public.languages));
});

test("a cleanup failure is reported without undoing the published manifest", async () => {
  const { privateStore, publicStore, dependencies } = await setup();
  const failing: ObjectStore = Object.assign(Object.create(publicStore) as ObjectStore, {
    list: async () => { throw new Error("list failed"); },
  });
  const outcome = await publishRelease(await result(), { ...dependencies, publicStore: failing });
  assert.ok(outcome.status === "published");
  assert.deepEqual(outcome.cleanup, { error: "list failed" });
  assert.deepEqual((await readManifest(privateStore, "fixture-alpha"))?.manifest, outcome.manifest);
});

test("publishing refuses swapped stores before writing anything", async () => {
  const { privateStore, publicStore, dependencies } = await setup();
  await assert.rejects(
    publishRelease(await result(), { ...dependencies, privateStore: publicStore, publicStore: privateStore }),
    /private state store and a public card store/,
  );
  assert.equal(privateStore.objects.size + publicStore.objects.size, 0);
});
