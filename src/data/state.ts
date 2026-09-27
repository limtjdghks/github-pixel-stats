import { readFile } from "node:fs/promises";
import { parseUsername } from "../username.js";
import { parseState, type LoadedState } from "./state-validation.js";

export type { LoadedState } from "./state-validation.js";

export async function loadState(path: string, expectedUsername: string): Promise<LoadedState> {
  const expected = parseUsername(expectedUsername);
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
  return parseState(parsed, expected, `State file ${path}`);
}
