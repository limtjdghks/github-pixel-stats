import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hasStateContentChanged } from "../src/data/collection-model.js";
import { loadState } from "../src/data/state.js";
import { loadUserFixture } from "./helpers/load-user-fixture.js";

test("loadState reuses a compatible v1 cache for the same account regardless of case", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gps-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.json");
  const { state } = await loadUserFixture("fixture-alpha");
  await writeFile(path, JSON.stringify(state));

  const loaded = await loadState(path, "Fixture-Alpha");

  assert.equal(loaded.cacheUsable, true);
  assert.deepEqual(loaded.state, state);
});

test("loadState treats a different account and unsupported version as cache misses", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gps-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.json");
  const { state } = await loadUserFixture("fixture-alpha");
  await writeFile(path, JSON.stringify(state));
  assert.deepEqual(await loadState(path, "fixture-beta"), { state: null, cacheUsable: false });

  await writeFile(path, JSON.stringify({ ...state, schemaVersion: 2 }));
  assert.deepEqual(await loadState(path, "fixture-alpha"), { state: null, cacheUsable: false });
});

test("loadState rejects corrupt JSON and invalid same-account content", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gps-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.json");
  await writeFile(path, "{");
  await assert.rejects(loadState(path, "fixture-alpha"), /not valid JSON/);

  const { state } = await loadUserFixture("fixture-alpha");
  await writeFile(path, JSON.stringify({ ...state, commits: [] }));
  await assert.rejects(loadState(path, "fixture-alpha"), /no commit map/);
});

test("username spelling changes mark an otherwise identical state as changed", async () => {
  const { state } = await loadUserFixture("fixture-alpha");

  assert.equal(hasStateContentChanged(state, { ...state, username: "Fixture-Alpha" }), true);
  assert.equal(hasStateContentChanged(state, { ...state }), false);
});
