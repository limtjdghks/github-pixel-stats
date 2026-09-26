import assert from "node:assert/strict";
import test from "node:test";
import { parseUsername, usernamesEqual } from "../src/username.js";

test("parseUsername trims surrounding whitespace and accepts GitHub name boundaries", () => {
  assert.equal(parseUsername("  Alice-2 \n"), "Alice-2");
  assert.equal(parseUsername("a"), "a");
  assert.equal(parseUsername("a".repeat(39)), "a".repeat(39));
});

test("parseUsername rejects empty, oversized, and invalid path or query input", () => {
  for (const value of [
    "",
    "  ",
    "a".repeat(40),
    "-alice",
    "alice-",
    "alice--2",
    "alice/bob",
    "alice?tab=repositories",
    "alice_bob",
    "한글",
  ]) {
    assert.throws(() => parseUsername(value), { message: /GitHub username/ });
  }
});

test("usernamesEqual ignores case but preserves distinct accounts", () => {
  assert.equal(usernamesEqual(" Alice-2 ", "alice-2"), true);
  assert.equal(usernamesEqual("alice-2", "alice-3"), false);
});
