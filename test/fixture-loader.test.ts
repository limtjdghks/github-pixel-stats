import assert from "node:assert/strict";
import test from "node:test";
import {
  loadUserFixture,
  parseGitHubResponsesFixture,
  USER_FIXTURE_NAMES,
} from "./helpers/load-user-fixture.js";

for (const fixtureName of USER_FIXTURE_NAMES) {
  test(`${fixtureName} keeps its own username`, async () => {
    const fixture = await loadUserFixture(fixtureName);

    assert.equal(fixture.id, fixtureName);
    assert.equal(fixture.githubResponses.username, fixtureName);
    assert.equal(fixture.state.username, fixtureName);
    assert.equal(fixture.snapshot.username, fixtureName);
  });
}

test("parseGitHubResponsesFixture rejects an invalid fixture object", () => {
  assert.throws(
    () => parseGitHubResponsesFixture({ username: "fixture-invalid", period: { from: 1, to: null } }),
    /GitHub responses fixture has an invalid period/,
  );
});
