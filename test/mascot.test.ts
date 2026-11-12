import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MASCOT_ID,
  getMascotRenderer,
  renderLanguagesCard,
  renderStatsCard,
  resolveMascotId,
  type MascotRenderer,
} from "../src/render/index.js";
import { loadUserFixture } from "./helpers/load-user-fixture.js";

test("registered cat ID selects the default mascot", () => {
  assert.equal(DEFAULT_MASCOT_ID, "cat");
  assert.equal(resolveMascotId("cat"), "cat");
  assert.match(getMascotRenderer(resolveMascotId("cat"))(414, 20), /transform="translate\(414 20\)"/);
});

test("unregistered and malformed IDs fall back to cat", () => {
  for (const raw of [
    undefined,
    null,
    "",
    " ",
    " cat",
    "cat ",
    "CAT",
    "Cat",
    "cat/other",
    "../cat",
    "cat.svg",
    "__proto__",
    "constructor",
    "toString",
  ]) {
    assert.equal(resolveMascotId(raw), DEFAULT_MASCOT_ID, String(raw));
  }
});

test("stats card uses the injected renderer at the fixed mascot position", async () => {
  const { snapshot } = await loadUserFixture("fixture-alpha");
  const calls: Array<[number, number]> = [];
  const renderer: MascotRenderer = (x, y) => {
    calls.push([x, y]);
    return `<g data-test-mascot="custom" transform="translate(${x} ${y})"/>`;
  };

  const statsSvg = renderStatsCard(snapshot, renderer);
  const defaultSvg = renderStatsCard(snapshot, getMascotRenderer(DEFAULT_MASCOT_ID));
  const languagesSvg = renderLanguagesCard(snapshot);

  assert.deepEqual(calls, [[414, 20]]);
  assert.match(statsSvg, /data-test-mascot="custom" transform="translate\(414 20\)"/);
  assert.doesNotMatch(statsSvg, /M10 0H84V4H90/);
  assert.match(defaultSvg, /M10 0H84V4H90/);
  assert.match(statsSvg, /width="570" height="300"/);
  assert.doesNotMatch(languagesSvg, /data-test-mascot|M10 0H84V4H90/);
});
