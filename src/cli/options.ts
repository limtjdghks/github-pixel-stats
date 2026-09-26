import { resolve } from "node:path";
import { parseUsername } from "../username.js";

export interface FileOptions {
  username: string;
  statePath: string;
  nextStatePath: string;
  outputPath: string;
}

export function parseFileOptions(argv: string[], environmentUsername?: string): FileOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error("Arguments must be provided as --username, --state, --next-state, and --out value pairs.");
    }
    values.set(key, value);
  }
  const supported = new Set(["--username", "--state", "--next-state", "--out"]);
  for (const key of values.keys()) {
    if (!supported.has(key)) {
      throw new Error(`Unknown argument: ${key}.`);
    }
  }
  const rawUsername = values.get("--username") ?? environmentUsername;
  if (rawUsername === undefined) {
    throw new Error("--username or GITHUB_USERNAME is required.");
  }
  return {
    username: parseUsername(rawUsername),
    statePath: resolve(values.get("--state") ?? ".state/state.json"),
    nextStatePath: resolve(values.get("--next-state") ?? "build/next-state.json"),
    outputPath: resolve(values.get("--out") ?? "dist"),
  };
}
