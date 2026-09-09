import { resolve } from "node:path";

export interface FileOptions {
  statePath: string;
  nextStatePath: string;
  outputPath: string;
}

export function parseFileOptions(argv: string[]): FileOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error("Arguments must be provided as --state, --next-state, and --out value pairs.");
    }
    values.set(key, value);
  }
  const supported = new Set(["--state", "--next-state", "--out"]);
  for (const key of values.keys()) {
    if (!supported.has(key)) {
      throw new Error(`Unknown argument: ${key}.`);
    }
  }
  return {
    statePath: resolve(values.get("--state") ?? ".state/state.json"),
    nextStatePath: resolve(values.get("--next-state") ?? "build/next-state.json"),
    outputPath: resolve(values.get("--out") ?? "dist"),
  };
}
