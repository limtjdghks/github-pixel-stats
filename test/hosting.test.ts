import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import cron from "../api/cron.js";
import health from "../api/health.js";
import { ROUTING_PARAMS } from "../src/hosting/card-request.js";
import { readHostingConfig } from "../src/hosting/environment.js";

test("hosting config accepts the three Vercel environments without requiring secrets", () => {
  assert.equal(readHostingConfig({}).environment, "development");
  for (const environment of ["production", "preview", "development"] as const) {
    assert.equal(readHostingConfig({ VERCEL_ENV: environment }).environment, environment);
  }
  assert.deepEqual(readHostingConfig({ VERCEL_ENV: "preview" }).credentials, {
    githubToken: undefined,
    cronSecret: undefined,
  });
  assert.equal(readHostingConfig({ VERCEL_ENV: "preview" }).blobStores, undefined);
});

test("hosting config requires two distinct Blob store IDs instead of a read-write token", () => {
  assert.deepEqual(
    readHostingConfig({ BLOB_PRIVATE_STORE_ID: " store_private ", BLOB_PUBLIC_STORE_ID: "store_public" }).blobStores,
    { privateStoreId: "store_private", publicStoreId: "store_public" },
  );
  for (const source of [
    { BLOB_PRIVATE_STORE_ID: "store_private" },
    { BLOB_PUBLIC_STORE_ID: "store_public" },
    { BLOB_PRIVATE_STORE_ID: "store_same", BLOB_PUBLIC_STORE_ID: " store_same" },
    { BLOB_PRIVATE_STORE_ID: "store_same", BLOB_PUBLIC_STORE_ID: "same" },
  ]) {
    assert.throws(() => readHostingConfig(source), /Invalid Blob store configuration/);
  }
  assert.equal("blobToken" in readHostingConfig({ BLOB_READ_WRITE_TOKEN: "unused" }).credentials, false);
});

test("hosting config rejects invalid values without echoing secrets", () => {
  assert.throws(() => readHostingConfig({ VERCEL_ENV: "other" }), /Invalid VERCEL_ENV configuration/);
  for (const key of ["GH_STATS_TOKEN", "CRON_SECRET", "BLOB_PRIVATE_STORE_ID", "BLOB_PUBLIC_STORE_ID"]) {
    assert.throws(() => readHostingConfig({ [key]: "  " }), new RegExp(`Invalid ${key} configuration`));
  }
  const secret = "private-test-secret";
  const config = readHostingConfig({ GH_STATS_TOKEN: secret });
  assert.equal(config.credentials.githubToken, secret);
  assert.equal(JSON.stringify({ status: "ok" }).includes(secret), false);
});

test("health and unconfigured cron endpoints return explicit states without external requests or secrets", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    throw new Error("Unexpected external request");
  };
  try {
    const cases = [
      [health, "/healthz", 200, { status: "ok" }],
      [cron, "/api/cron", 503, { status: "not_configured" }],
    ] as const;
    for (const [handler, path, status, body] of cases) {
      const response = await handler.fetch(new Request(`https://example.test${path}`));
      assert.equal(response.status, status, path);
      assert.equal(response.headers.get("Cache-Control"), "no-store", path);
      assert.deepEqual(await response.json(), body, path);
      assert.equal(JSON.stringify(body).includes("private-test-secret"), false);
    }
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HEAD omits response bodies and unsupported methods return 405", async () => {
  const head = health.fetch(new Request("https://example.test/healthz", { method: "HEAD" }));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const post = health.fetch(new Request("https://example.test/healthz", { method: "POST" }));
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("Allow"), "GET, HEAD");
  const cronHead = await cron.fetch(new Request("https://example.test/api/cron", { method: "HEAD" }));
  assert.equal(cronHead.status, 405);
  assert.equal(cronHead.headers.get("Allow"), "GET");
});

test("Vercel routes and function resource declarations match the public contract", async () => {
  const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8")) as {
    builds?: unknown;
    outputDirectory?: string;
    functions: Record<string, { includeFiles?: string; maxDuration: number; regions: string[] }>;
    crons: Array<{ path: string; schedule: string }>;
    rewrites: Array<{ source: string; destination: string }>;
  };
  assert.equal(config.builds, undefined);
  assert.equal(config.outputDirectory, "public");
  // 카드 route가 읽는 rewrite query 이름과 vercel.json이 같아야 합니다.
  const { card, username } = ROUTING_PARAMS;
  assert.deepEqual(config.rewrites, [
    { source: "/healthz", destination: "/api/health" },
    { source: "/:username/stats.svg", destination: `/api/card?${card}=stats&${username}=:username` },
    { source: "/:username/languages.svg", destination: `/api/card?${card}=languages&${username}=:username` },
  ]);
  // Hobby Cron은 하루 1회만 허용되므로 매일 실행되는 UTC schedule 하나만 둡니다.
  assert.deepEqual(config.crons, [{ path: "/api/cron", schedule: "17 18 * * *" }]);
  // 카드 Function은 bootstrap에서, Cron은 갱신에서 수집·발행하므로 둘 다 폰트와 Linguist 데이터가 필요합니다.
  for (const name of ["api/card.ts", "api/cron.ts"]) {
    assert.equal(config.functions[name]?.includeFiles, "{assets/fonts/**/*.woff2,data/languages.yml}");
  }
  assert.deepEqual(
    Object.fromEntries(Object.entries(config.functions).map(([name, settings]) => [name, settings.maxDuration])),
    { "api/health.ts": 10, "api/card.ts": 30, "api/cron.ts": 300 },
  );
  for (const settings of Object.values(config.functions)) {
    assert.deepEqual(settings.regions, ["iad1"]);
  }
});
