import assert from "node:assert/strict";
import test from "node:test";
import type { CollectionCheckpoint } from "../src/data/checkpoint-model.js";
import { ObjectCheckpointStore } from "../src/storage/checkpoint-object-store.js";
import { parseManifest, referencedPathnames, type CardManifest } from "../src/storage/manifest.js";
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

test("release versions are stable for the same result and change with content", async () => {
  const { snapshot, state } = await loadUserFixture("fixture-alpha");
  const version = createReleaseVersion(snapshot, state);
  assert.match(version, /^\d{8}-\d{6}-[0-9a-f]{16}$/);
  assert.equal(createReleaseVersion(structuredClone(snapshot), structuredClone(state)), version);
  const changed = structuredClone(snapshot);
  changed.stats.stars += 1;
  assert.notEqual(createReleaseVersion(changed, state), version);
});

test("manifests are validated and expose only current and previous release pathnames", () => {
  const manifest: CardManifest = {
    schemaVersion: 1,
    username: "Fixture-Alpha",
    publishedAt: "2026-10-01T00:00:00.000Z",
    current: { version: VERSION, generatedAt: "2026-09-12T23:59:59.000Z", mascots: ["cat"] },
    previous: null,
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
    [{ ...manifest, current: { ...manifest.current, mascots: ["dog"] } }, "fixture-alpha", /invalid release/],
    [{ ...manifest, current: { ...manifest.current, mascots: [] } }, "fixture-alpha", /invalid release/],
  ];
  for (const [value, username, error] of invalid) {
    assert.throws(() => parseManifest(value, username), error);
  }
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

test("object checkpoint store refuses public stores", () => {
  assert.throws(() => new ObjectCheckpointStore(new MemoryObjectStore("public")), /private store/);
});
