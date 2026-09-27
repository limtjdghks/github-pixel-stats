import type { CachedCommit, CollectorState } from "../model.js";
import { CLASSIFIER_VERSION, LINGUIST_VERSION, STATE_SCHEMA_VERSION } from "../model.js";
import { parseUsername, usernamesEqual } from "../username.js";

export interface LoadedState {
  state: CollectorState | null;
  cacheUsable: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertCachedCommit(key: string, value: unknown): asserts value is CachedCommit {
  if (!isRecord(value)) {
    throw new Error(`State commit ${key} is not an object.`);
  }
  if (
    !Number.isSafeInteger(value.repositoryId) ||
    Number(value.repositoryId) <= 0 ||
    typeof value.repository !== "string" ||
    !value.repository.includes("/") ||
    typeof value.sha !== "string" ||
    !/^[\da-f]{40}(?:[\da-f]{24})?$/i.test(value.sha) ||
    typeof value.authoredAt !== "string" ||
    Number.isNaN(Date.parse(value.authoredAt)) ||
    !Array.isArray(value.languages) ||
    !value.languages.every((language) => typeof language === "string" && language.length > 0) ||
    new Set(value.languages).size !== value.languages.length
  ) {
    throw new Error(`State commit ${key} has an invalid shape.`);
  }
  if (`${value.repositoryId}:${value.sha}` !== key) {
    throw new Error(`State commit key ${key} does not match its repository and SHA.`);
  }
}

export function parseState(parsed: unknown, expectedUsername: string, label = "State"): LoadedState {
  const expected = parseUsername(expectedUsername);
  if (!isRecord(parsed)) {
    throw new Error(`${label} has an invalid shape.`);
  }
  if (parsed.schemaVersion !== STATE_SCHEMA_VERSION) {
    return { state: null, cacheUsable: false };
  }
  if (typeof parsed.username !== "string" || parsed.username !== parseUsername(parsed.username)) {
    throw new Error(`${label} has an invalid username.`);
  }
  if (!usernamesEqual(parsed.username, expected)) {
    return { state: null, cacheUsable: false };
  }
  if (!isRecord(parsed.classifier)) {
    throw new Error(`${label} has invalid classifier metadata.`);
  }
  if (
    parsed.classifier.version !== CLASSIFIER_VERSION ||
    parsed.classifier.linguistVersion !== LINGUIST_VERSION
  ) {
    return { state: null, cacheUsable: false };
  }
  if (!isRecord(parsed.commits)) {
    throw new Error(`${label} has no commit map.`);
  }
  if (
    typeof parsed.updatedAt !== "string" ||
    Number.isNaN(Date.parse(parsed.updatedAt))
  ) {
    throw new Error(`${label} has invalid metadata.`);
  }
  const commits: Record<string, CachedCommit> = {};
  for (const [key, commit] of Object.entries(parsed.commits)) {
    assertCachedCommit(key, commit);
    commits[key] = commit;
  }

  return {
    state: {
      schemaVersion: STATE_SCHEMA_VERSION,
      username: parsed.username,
      classifier: { version: CLASSIFIER_VERSION, linguistVersion: LINGUIST_VERSION },
      updatedAt: parsed.updatedAt,
      commits,
    },
    cacheUsable: true,
  };
}
