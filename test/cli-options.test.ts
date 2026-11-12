import assert from "node:assert/strict";
import test from "node:test";
import { parseFileOptions } from "../src/cli/options.js";

test("CLI username takes precedence over the environment and preserves spelling", () => {
  assert.equal(parseFileOptions(["--username", "  Alice-2  "], "fallback").username, "Alice-2");
  assert.equal(parseFileOptions([], "  Env-User  ").username, "Env-User");
});

test("CLI rejects missing, blank, and invalid usernames", () => {
  assert.throws(() => parseFileOptions([], undefined), /required/);
  assert.throws(() => parseFileOptions([], "  "), /GitHub username/);
  assert.throws(() => parseFileOptions(["--username", "  "], "valid-user"), /GitHub username/);
  assert.throws(() => parseFileOptions(["--username", "alice/bob"], "valid-user"), /GitHub username/);
});

test("CLI rejects incomplete or unknown arguments", () => {
  assert.throws(() => parseFileOptions(["--username"], undefined), /Arguments must be provided/);
  assert.throws(() => parseFileOptions(["--unknown", "value"], "valid-user"), /Unknown argument/);
});
