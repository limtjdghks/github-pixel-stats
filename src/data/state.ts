import { readFile } from "node:fs/promises";
import type { CachedCommit, CollectorState } from "../model.js";
import { CLASSIFIER_VERSION, LINGUIST_VERSION, STATE_SCHEMA_VERSION, USERNAME } from "../model.js";

export interface LoadedState {
  state: CollectorState | null;
  cacheUsable: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertCachedCommit(key: string, value: unknown): asserts value is CachedCommit {
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

export async function loadState(path: string): Promise<LoadedState> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: null, cacheUsable: false };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(`State file ${path} is not valid JSON.`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`State file ${path} has an invalid shape.`);
  }
  if (parsed.schemaVersion !== STATE_SCHEMA_VERSION || parsed.username !== USERNAME) {
    return { state: null, cacheUsable: false };
  }
  if (!isRecord(parsed.classifier)) {
    throw new Error(`State file ${path} has invalid classifier metadata.`);
  }
  if (
    parsed.classifier.version !== CLASSIFIER_VERSION ||
    parsed.classifier.linguistVersion !== LINGUIST_VERSION
  ) {
    return { state: null, cacheUsable: false };
  }
  if (!isRecord(parsed.commits)) {
    throw new Error(`State file ${path} has no commit map.`);
  }
  if (
    typeof parsed.updatedAt !== "string" ||
    Number.isNaN(Date.parse(parsed.updatedAt)) ||
    typeof parsed.username !== "string"
  ) {
    throw new Error(`State file ${path} has invalid metadata.`);
  }
  for (const [key, commit] of Object.entries(parsed.commits)) {
    assertCachedCommit(key, commit);
  }

  return {
    state: parsed as unknown as CollectorState,
    cacheUsable: true,
  };
}

export function hasStateContentChanged(previous: CollectorState | null, next: CollectorState): boolean {
  if (!previous) {
    return true;
  }
  return JSON.stringify(previous.commits) !== JSON.stringify(next.commits);
}
