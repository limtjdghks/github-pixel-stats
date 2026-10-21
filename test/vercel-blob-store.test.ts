import assert from "node:assert/strict";
import test from "node:test";
import { BlobError, BlobPreconditionFailedError, BlobServiceNotAvailable } from "@vercel/blob";
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

test("vercel blob adapter reads through the CDN cache only for immutable objects", async () => {
  const { sdk, store: blobStore } = store("public");
  await blobStore.write("cards/alpha/v1/languages.svg", "<svg/>", { ...write, condition: { kind: "content-addressed" } });
  await blobStore.read("cards/alpha/v1/languages.svg", undefined, { immutable: true });
  await blobStore.read("cards/alpha/v1/languages.svg", undefined, { immutable: false });
  await blobStore.read("cards/alpha/v1/languages.svg");
  assert.deepEqual(sdk.calls.filter((call) => call.method === "get").map((call) => call.options.useCache), [true, false, false]);
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
  const match = sdk.calls.findLast((call) => call.method === "put");
  assert.equal(match?.options.ifMatch, "\"old\"");
  assert.equal(match?.options.allowOverwrite, undefined);

  sdk.put = async () => { throw new BlobServiceNotAvailable(); };
  await assert.rejects(blobStore.write("manifests/beta.json", "x", { ...write, condition: { kind: "absent" } }), BlobServiceNotAvailable);
  await assert.rejects(blobStore.write("manifests/alpha.json", "x", { ...write, condition: { kind: "match", etag } }), BlobServiceNotAvailable);
});

test("vercel blob adapter treats a write that landed before an SDK retry failure as success", async () => {
  // 첫 PUT은 반영됐지만 응답이 유실되고, SDK 자동 재시도가 충돌 오류로 끝나는 상황을 흉내 냅니다.
  const sdk = new FakeBlobSdk();
  const { store: blobStore } = store("private", sdk);
  const landedThenFailed = (failure: () => Error) => async (...args: Parameters<FakeBlobSdk["put"]>) => {
    await FakeBlobSdk.prototype.put.apply(sdk, args);
    throw failure();
  };

  sdk.put = landedThenFailed(() => new BlobError("This blob already exists."));
  const created = await blobStore.write("manifests/alpha.json", "one", { ...write, condition: { kind: "absent" } });
  assert.equal(created, sdk.blobs.get("manifests/alpha.json")?.etag);

  sdk.put = landedThenFailed(() => new BlobPreconditionFailedError());
  const replaced = await blobStore.write("manifests/alpha.json", "two", { ...write, condition: { kind: "match", etag: created! } });
  assert.equal(replaced, sdk.blobs.get("manifests/alpha.json")?.etag);
  assert.notEqual(replaced, created);

  // 다른 실행이 쓴 내용이 남아 있으면 여전히 충돌입니다.
  sdk.put = async () => { throw new BlobPreconditionFailedError(); };
  assert.equal(await blobStore.write("manifests/alpha.json", "three", { ...write, condition: { kind: "match", etag: replaced! } }), null);
  sdk.put = async () => { throw new BlobError("This blob already exists."); };
  assert.equal(await blobStore.write("manifests/alpha.json", "four", { ...write, condition: { kind: "absent" } }), null);
});
