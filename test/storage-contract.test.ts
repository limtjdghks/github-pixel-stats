import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FilesystemObjectStore } from "../src/storage/filesystem-store.js";
import type { ObjectStore, WriteOptions } from "../src/storage/object-store.js";
import { VercelBlobObjectStore } from "../src/storage/vercel-blob-store.js";
import { FakeBlobSdk } from "./helpers/fake-blob-sdk.js";
import { MemoryObjectStore } from "./helpers/memory-object-store.js";

// 모든 adapter가 같은 ObjectStore 계약을 지키는지 확인합니다. 실제 Blob API는 FakeBlobSdk로 대체합니다.
const adapters: Array<{ name: string; create(): Promise<{ store: ObjectStore; close(): Promise<void> }> }> = [
  {
    name: "memory",
    async create() {
      return { store: new MemoryObjectStore("private"), close: async () => undefined };
    },
  },
  {
    name: "filesystem",
    async create() {
      const root = await mkdtemp(join(tmpdir(), "gps-store-"));
      return { store: new FilesystemObjectStore(root, "private"), close: () => rm(root, { recursive: true, force: true }) };
    },
  },
  {
    name: "vercel blob",
    async create() {
      const store = new VercelBlobObjectStore({
        access: "private", storeId: "store_private", getOidcToken: async () => "oidc-test", sdk: new FakeBlobSdk(),
      });
      return { store, close: async () => undefined };
    },
  },
];

const options = (condition: WriteOptions["condition"]): WriteOptions => ({
  contentType: "application/json", cacheControlMaxAge: 60, condition,
});

for (const adapter of adapters) {
  test(`${adapter.name} store creates only absent objects and reads them back`, async () => {
    const { store, close } = await adapter.create();
    try {
      assert.equal(await store.read("manifests/alpha.json"), null);
      const etag = await store.write("manifests/alpha.json", "one", options({ kind: "absent" }));
      assert.ok(etag);
      assert.equal(await store.write("manifests/alpha.json", "two", options({ kind: "absent" })), null);
      assert.deepEqual(await store.read("manifests/alpha.json"), { body: "one", etag });
    } finally {
      await close();
    }
  });

  test(`${adapter.name} store replaces only the matching ETag`, async () => {
    const { store, close } = await adapter.create();
    try {
      const first = await store.write("manifests/alpha.json", "one", options({ kind: "absent" }));
      assert.ok(first);
      const second = await store.write("manifests/alpha.json", "two", options({ kind: "match", etag: first }));
      assert.ok(second);
      assert.notEqual(second, first);
      assert.equal(await store.write("manifests/alpha.json", "stale", options({ kind: "match", etag: first })), null);
      assert.equal(await store.write("manifests/missing.json", "x", options({ kind: "match", etag: first })), null);
      assert.equal((await store.read("manifests/alpha.json"))?.body, "two");
      assert.equal(await store.read("manifests/missing.json"), null);
    } finally {
      await close();
    }
  });

  test(`${adapter.name} store lets exactly one of two concurrent conditional writers win`, async () => {
    const { store, close } = await adapter.create();
    try {
      const base = await store.write("manifests/alpha.json", "base", options({ kind: "absent" }));
      assert.ok(base);
      const results = await Promise.all(["left", "right"].map((body) =>
        store.write("manifests/alpha.json", body, options({ kind: "match", etag: base }))));
      assert.equal(results.filter((result) => result !== null).length, 1);
      const winner = results[0] !== null ? "left" : "right";
      assert.equal((await store.read("manifests/alpha.json"))?.body, winner);
    } finally {
      await close();
    }
  });

  test(`${adapter.name} store rewrites content-addressed objects idempotently`, async () => {
    const { store, close } = await adapter.create();
    try {
      assert.ok(await store.write("cards/alpha/v/languages.svg", "<svg/>", options({ kind: "content-addressed" })));
      assert.ok(await store.write("cards/alpha/v/languages.svg", "<svg/>", options({ kind: "content-addressed" })));
      assert.equal((await store.read("cards/alpha/v/languages.svg"))?.body, "<svg/>");
    } finally {
      await close();
    }
  });

  test(`${adapter.name} store lists by prefix across pages and deletes`, async () => {
    const { store, close } = await adapter.create();
    try {
      for (const pathname of ["cards/alpha/1/a.svg", "cards/alpha/1/b.svg", "cards/alpha/2/a.svg", "cards/alphabet/1/a.svg"]) {
        await store.write(pathname, pathname, options({ kind: "content-addressed" }));
      }
      const listed = await store.list("cards/alpha/");
      assert.deepEqual(listed.map((entry) => entry.pathname).sort(), ["cards/alpha/1/a.svg", "cards/alpha/1/b.svg", "cards/alpha/2/a.svg"]);
      assert.ok(listed.every((entry) => entry.uploadedAt instanceof Date && !Number.isNaN(entry.uploadedAt.getTime())));
      await store.delete(["cards/alpha/1/a.svg", "cards/alpha/9/missing.svg"]);
      assert.equal(await store.read("cards/alpha/1/a.svg"), null);
      assert.equal((await store.list("cards/alpha/")).length, 2);
      assert.deepEqual(await store.list("cards/none/"), []);
    } finally {
      await close();
    }
  });

  test(`${adapter.name} store rejects unsafe pathnames before touching storage`, async () => {
    const { store, close } = await adapter.create();
    try {
      for (const pathname of ["../escape.json", "/abs.json", "a//b.json", "a/.hidden", "A/upper.json", "a/b/", "a/b..c"]) {
        await assert.rejects(store.read(pathname), /Invalid object pathname/);
        await assert.rejects(store.write(pathname, "x", options({ kind: "absent" })), /Invalid object pathname/);
      }
      await assert.rejects(store.list("cards/alpha"), /Invalid object prefix/);
    } finally {
      await close();
    }
  });
}

test("filesystem store skips entries removed between readdir and stat", async () => {
  const root = await mkdtemp(join(tmpdir(), "gps-store-"));
  try {
    const store = new FilesystemObjectStore(root, "public");
    await store.write("cards/alpha/1/a.svg", "<svg/>", options({ kind: "content-addressed" }));
    // 끊어진 symlink는 readdir에는 보이지만 stat에서 ENOENT가 나므로 동시 삭제와 같은 경로를 탑니다.
    await mkdir(join(root, "cards", "alpha", "2"), { recursive: true });
    await symlink(join(root, "missing.svg"), join(root, "cards", "alpha", "2", "gone.svg"));
    assert.deepEqual((await store.list("cards/alpha/")).map((entry) => entry.pathname), ["cards/alpha/1/a.svg"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
