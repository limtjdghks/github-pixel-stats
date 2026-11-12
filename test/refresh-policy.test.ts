import assert from "node:assert/strict";
import test from "node:test";
import { REFRESH_INTERVAL_MS, selectDueUsers } from "../src/hosting/refresh-policy.js";
import { CHECKPOINT_PREFIX, MANIFEST_PREFIX, userKeyFromPathname } from "../src/storage/pathnames.js";

const NOW = new Date("2026-10-02T18:00:00.000Z");
const at = (offset: number) => new Date(NOW.getTime() + offset);
const entry = (pathname: string, uploadedAt = NOW) => ({ pathname, uploadedAt });

test("published users whose manifest reached the refresh interval come first, then unpublished users", () => {
  const due = selectDueUsers(
    [
      entry("checkpoints/zeta.json"), entry("checkpoints/alpha.json"),
      entry("checkpoints/fresh.json"), entry("checkpoints/older.json"),
    ],
    [
      entry("manifests/fresh.json", at(-REFRESH_INTERVAL_MS + 1)),
      entry("manifests/edge.json", at(-REFRESH_INTERVAL_MS)),
      entry("manifests/older.json", at(-REFRESH_INTERVAL_MS * 2)),
    ],
    NOW,
  );
  assert.deepEqual(due, ["older", "edge", "alpha", "zeta"]);
});

test("pathnames outside the user key format are ignored", () => {
  assert.deepEqual(selectDueUsers(
    [entry("checkpoints/bad--name.json"), entry("checkpoints/Upper.json"), entry("checkpoints/nested/user.json"), entry("checkpoints/user.txt")],
    [entry("manifests/-bad.json", at(-REFRESH_INTERVAL_MS))],
    NOW,
  ), []);
  assert.equal(userKeyFromPathname(CHECKPOINT_PREFIX, "manifests/user.json"), null);
  assert.equal(userKeyFromPathname(MANIFEST_PREFIX, "manifests/fixture-alpha.json"), "fixture-alpha");
});

test("deferred unpublished users come after the other unpublished users and never before published users", () => {
  const due = selectDueUsers(
    [entry("checkpoints/alpha.json"), entry("checkpoints/beta.json"), entry("checkpoints/gamma.json"), entry("checkpoints/older.json")],
    [entry("manifests/older.json", at(-REFRESH_INTERVAL_MS))],
    NOW,
    new Set(["alpha", "older"]),
  );
  assert.deepEqual(due, ["older", "beta", "gamma", "alpha"]);
});
