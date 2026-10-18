import assert from "node:assert/strict";
import test from "node:test";
import { BlobServiceNotAvailable } from "@vercel/blob";
import { VercelBlobObjectStore } from "../src/storage/vercel-blob-store.js";
import { FakeBlobSdk } from "./helpers/fake-blob-sdk.js";

function store(access: "private" | "public", sdk = new FakeBlobSdk(), token = "oidc-test") {
  return { sdk, store: new VercelBlobObjectStore({ access, storeId: ` store_${access} `, getOidcToken: async () => token, sdk }) };
}

const write = { contentType: "application/json", cacheControlMaxAge: 60 } as const;

test("vercel blob adapter sends its access mode, store ID, and OIDC token on every call", async () => {
  for (const access of ["private", "public"] as const) {
    const { sdk, store: blobStore } = store(access);
    await blobStore.write("manifests/alpha.json", "{}", { ...write, condition: { kind: "absent" } });
    await blobStore.read("manifests/alpha.json");
    await blobStore.list("manifests/");
    await blobStore.delete(["manifests/alpha.json"]);
    assert.deepEqual(sdk.calls.map((call) => call.method), ["put", "get", "list", "del"]);
    for (const call of sdk.calls) {
      assert.equal(call.options.storeId, `store_${access}`);
      assert.equal(call.options.oidcToken, "oidc-test");
      assert.equal(call.options.token, undefined, "a long-lived read-write token must never be passed");
    }
    const [put, get] = sdk.calls;
    assert.equal(put?.options.access, access);
    assert.equal(put?.options.addRandomSuffix, false);
    assert.equal(get?.options.access, access);
    assert.equal(get?.options.useCache, false);
  }
});

test("vercel blob adapter never exposes a blob URL from private reads", async () => {
  const { store: blobStore } = store("private");
  await blobStore.write("checkpoints/alpha.json", "{\"a\":1}", { ...write, condition: { kind: "absent" } });
  const stored = await blobStore.read("checkpoints/alpha.json");
  assert.deepEqual(Object.keys(stored ?? {}).sort(), ["body", "etag"]);
  assert.equal(JSON.stringify(stored).includes("https://"), false);
});

test("vercel blob adapter fails before any request when the OIDC token is unavailable", async () => {
  const { sdk, store: blobStore } = store("private", new FakeBlobSdk(), "  ");
  await assert.rejects(blobStore.read("manifests/alpha.json"), /OIDC token is unavailable/);
  await assert.rejects(blobStore.write("manifests/alpha.json", "{}", { ...write, condition: { kind: "absent" } }), /OIDC token is unavailable/);
  assert.equal(sdk.calls.length, 0);
  assert.throws(() => new VercelBlobObjectStore({ access: "private", storeId: " ", getOidcToken: async () => "t", sdk }), /store ID is required/);
});

test("vercel blob adapter maps conditional failures to null but rethrows service errors", async () => {
  const sdk = new FakeBlobSdk();
  const { store: blobStore } = store("private", sdk);
  const etag = await blobStore.write("manifests/alpha.json", "one", { ...write, condition: { kind: "absent" } });
  assert.ok(etag);
  assert.equal(await blobStore.write("manifests/alpha.json", "two", { ...write, condition: { kind: "absent" } }), null);
  assert.equal(await blobStore.write("manifests/alpha.json", "two", { ...write, condition: { kind: "match", etag: "\"old\"" } }), null);
  const match = sdk.calls.at(-1);
  assert.equal(match?.options.ifMatch, "\"old\"");
  assert.equal(match?.options.allowOverwrite, undefined);

  sdk.put = async () => { throw new BlobServiceNotAvailable(); };
  await assert.rejects(blobStore.write("manifests/beta.json", "x", { ...write, condition: { kind: "absent" } }), BlobServiceNotAvailable);
  await assert.rejects(blobStore.write("manifests/alpha.json", "x", { ...write, condition: { kind: "match", etag } }), BlobServiceNotAvailable);
});
