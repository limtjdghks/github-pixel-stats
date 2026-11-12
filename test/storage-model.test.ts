import assert from "node:assert/strict";
import test from "node:test";
import type { CollectionCheckpoint } from "../src/data/checkpoint-model.js";
import { ObjectCheckpointStore } from "../src/storage/checkpoint-object-store.js";
import { nextManifest, parseManifest, referencedPathnames, type CardManifest } from "../src/storage/manifest.js";
import {
  cardPrefix,
  checkpointPathname,
  createReleaseVersion,
  manifestPathname,
  releasePathnames,
  releasePrefix,
} from "../src/storage/pathnames.js";
import { loadUserFixture } from "./helpers/load-user-fixture.js";
import { MemoryObjectStore } from "./helpers/memory-object-store.js";

const VERSION = "20260912-235959-0123456789abcdef";

test("pathnames normalize usernames and keep private and public prefixes apart", () => {
  assert.equal(manifestPathname("Fixture-Alpha"), "manifests/fixture-alpha.json");
  assert.equal(checkpointPathname(" fixture-alpha "), "checkpoints/fixture-alpha.json");
  assert.equal(releasePrefix("FIXTURE-ALPHA"), "releases/fixture-alpha/");
  assert.equal(cardPrefix("Fixture-Alpha"), "cards/fixture-alpha/");
  assert.deepEqual(releasePathnames("Fixture-Alpha", VERSION, ["cat"]), {
    private: {
      snapshot: `releases/fixture-alpha/${VERSION}/snapshot.json`,
      state: `releases/fixture-alpha/${VERSION}/state.json`,
    },
    public: {
      languages: `cards/fixture-alpha/${VERSION}/languages.svg`,
      stats: { cat: `cards/fixture-alpha/${VERSION}/stats-cat.svg` },
    },
  });
  for (const username of ["../etc", "a/b", "-bad", "a".repeat(40)]) {
    assert.throws(() => manifestPathname(username), /GitHub username/);
  }
  assert.throws(() => releasePathnames("fixture-alpha", "../x", ["cat"]), /Invalid release version/);
});

test("release versions are stable for the same result and change with data or rendered cards", async () => {
  const { snapshot, state } = await loadUserFixture("fixture-alpha");
  const cards = { languages: "<svg>a</svg>", cat: "<svg>b</svg>" };
  const version = createReleaseVersion(snapshot, state, cards);
  assert.match(version, /^\d{8}-\d{6}-[0-9a-f]{16}$/);
  assert.equal(createReleaseVersion(structuredClone(snapshot), structuredClone(state), { ...cards }), version);
  const changed = structuredClone(snapshot);
  changed.stats.stars += 1;
  assert.notEqual(createReleaseVersion(changed, state, cards), version);
  assert.notEqual(createReleaseVersion(snapshot, state, { ...cards, cat: "<svg>renderer v2</svg>" }), version,
    "a renderer change must not reuse the pathnames of cards that are already cached");
});

test("manifests are validated and expose only current and previous release pathnames", () => {
  const manifest: CardManifest = {
    schemaVersion: 1,
    username: "Fixture-Alpha",
    publishedAt: "2026-10-01T00:00:00.000Z",
    current: { version: VERSION, generatedAt: "2026-09-12T23:59:59.000Z", mascots: ["cat"] },
    previous: null,
    retired: [],
  };
  assert.deepEqual(parseManifest(JSON.parse(JSON.stringify(manifest)), "fixture-alpha"), manifest);
  const references = referencedPathnames(manifest);
  assert.deepEqual([...references.private], [
    `releases/fixture-alpha/${VERSION}/snapshot.json`, `releases/fixture-alpha/${VERSION}/state.json`,
  ]);
  assert.deepEqual([...references.public], [
    `cards/fixture-alpha/${VERSION}/languages.svg`, `cards/fixture-alpha/${VERSION}/stats-cat.svg`,
  ]);

  const invalid: Array<[unknown, string, RegExp]> = [
    [{ ...manifest, schemaVersion: 2 }, "fixture-alpha", /unsupported shape/],
    [manifest, "fixture-beta", /unexpected username/],
    [{ ...manifest, publishedAt: "never" }, "fixture-alpha", /invalid publishedAt/],
    [{ ...manifest, current: { ...manifest.current, version: "../../x" } }, "fixture-alpha", /invalid release/],
    [{ ...manifest, current: { ...manifest.current, mascots: ["cat", "cat"] } }, "fixture-alpha", /invalid release/],
    [{ ...manifest, current: { ...manifest.current, mascots: [1] } }, "fixture-alpha", /invalid release/],
    [{ ...manifest, retired: undefined }, "fixture-alpha", /invalid retired list/],
    [{ ...manifest, retired: [{ ...manifest.current }] }, "fixture-alpha", /invalid retired release/],
    [{ ...manifest, current: { ...manifest.current, mascots: [] } }, "fixture-alpha", /invalid release/],
  ];
  for (const [value, username, error] of invalid) {
    assert.throws(() => parseManifest(value, username), error);
  }
});

test("next manifests retire the previous release and keep it only during the grace period", () => {
  const release = (minute: number) => ({
    version: `20260912-23${String(minute).padStart(2, "0")}00-0123456789abcdef`,
    generatedAt: `2026-09-12T23:${String(minute).padStart(2, "0")}:00.000Z`,
    mascots: ["cat" as const],
  });
  const at = (minutes: number) => new Date(Date.parse("2026-10-01T00:00:00.000Z") + minutes * 60_000);
  const first = nextManifest(null, "fixture-alpha", release(1), at(0));
  assert.deepEqual([first.previous, first.retired], [null, []]);
  const second = nextManifest(first, "fixture-alpha", release(2), at(120));
  assert.deepEqual([second.previous, second.retired], [release(1), []]);
  const third = nextManifest(second, "fixture-alpha", release(3), at(121));
  assert.deepEqual(third.retired, [{ ...release(1), retiredAt: at(121).toISOString() }],
    "a release uploaded long ago is kept from the moment it stops being previous");
  const fourth = nextManifest(third, "fixture-alpha", release(4), at(180));
  assert.deepEqual(fourth.retired.map((entry) => entry.version), [release(1).version, release(2).version]);
  const fifth = nextManifest(fourth, "fixture-alpha", release(5), at(182));
  assert.deepEqual(fifth.retired.map((entry) => entry.version), [release(2).version, release(3).version]);
  assert.equal(nextManifest(fifth, "fixture-alpha", release(2), at(183)).retired.some((entry) => entry.version === release(2).version), false,
    "a retired version that becomes current again is not also listed as retired");
});

test("manifests stay readable after a mascot is removed from the registry", () => {
  const release = { version: VERSION, generatedAt: "2026-09-12T23:59:59.000Z" };
  const manifest = parseManifest({
    schemaVersion: 1,
    username: "fixture-alpha",
    publishedAt: "2026-10-01T00:00:00.000Z",
    current: { ...release, mascots: ["retired", "cat"] },
    previous: { ...release, mascots: ["retired"] },
    retired: [],
  }, "fixture-alpha");
  assert.deepEqual(manifest.current.mascots, ["cat"]);
  assert.deepEqual(manifest.previous?.mascots, []);
  assert.equal([...referencedPathnames(manifest).public].some((pathname) => pathname.includes("retired")), false);
});

function checkpoint(lease: CollectionCheckpoint["lease"]): CollectionCheckpoint {
  return { lease } as CollectionCheckpoint;
}

test("object checkpoint store uses ETag revisions and honors lease guards", async () => {
  const signal = new AbortController().signal;
  const store = new ObjectCheckpointStore(new MemoryObjectStore("private"));
  assert.equal(await store.load("fixture-alpha", signal), null);
  const lease = { owner: "worker-a", expiresAt: "2026-10-01T00:05:00.000Z" };
  const first = await store.compareAndSwap("fixture-alpha", null, checkpoint(lease), null, signal);
  assert.ok(first);
  assert.equal(await store.compareAndSwap("fixture-alpha", null, checkpoint(null), null, signal), null);
  assert.deepEqual(await store.load("fixture-alpha", signal), { revision: first, value: { lease } });

  const now = "2026-10-01T00:01:00.000Z";
  assert.equal(await store.compareAndSwap("fixture-alpha", "\"stale\"", checkpoint(lease), { owner: "worker-a", now }, signal), null);
  assert.equal(await store.compareAndSwap("fixture-alpha", first, checkpoint(lease), { owner: "worker-b", now }, signal), null);
  assert.equal(await store.compareAndSwap("fixture-alpha", first, checkpoint(lease), { owner: "worker-a", now: lease.expiresAt }, signal), null);
  const second = await store.compareAndSwap("fixture-alpha", first, checkpoint(lease), { owner: "worker-a", now }, signal);
  assert.ok(second);
  assert.notEqual(second, first);
});

test("object checkpoint lease guards do not compare read and write ETag strings", async () => {
  const signal = new AbortController().signal;
  const memory = new MemoryObjectStore("private");
  // Blob의 get 응답 헤더 ETag는 put 응답 ETag와 표기가 다를 수 있으므로 read 결과만 다른 형식으로 바꿉니다.
  const store = new ObjectCheckpointStore(Object.assign(Object.create(memory) as MemoryObjectStore, {
    read: async (pathname: string) => {
      const stored = await memory.read(pathname);
      return stored && { ...stored, etag: `W/${stored.etag}` };
    },
  }));
  const lease = { owner: "worker-a", expiresAt: "2026-10-01T00:05:00.000Z" };
  const first = await store.compareAndSwap("fixture-alpha", null, checkpoint(lease), null, signal);
  assert.ok(first);
  const now = "2026-10-01T00:01:00.000Z";
  assert.ok(await store.compareAndSwap("fixture-alpha", first, checkpoint(lease), { owner: "worker-a", now }, signal));
  assert.equal(await store.compareAndSwap("fixture-alpha", first, checkpoint(lease), { owner: "worker-a", now }, signal), null);
});

test("object checkpoint store refuses public stores", () => {
  assert.throws(() => new ObjectCheckpointStore(new MemoryObjectStore("public")), /private store/);
});
