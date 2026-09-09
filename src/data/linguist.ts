import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { FALLBACK_LANGUAGE_COLOR } from "../model.js";

interface LanguageDefinition {
  type?: string;
  color?: string;
  group?: string;
  extensions?: string[];
  filenames?: string[];
}

type CandidateMap = Map<string, Map<string, boolean>>;
const EXCLUDED_CANDIDATE = "\u0000excluded";

const EXCLUDED_DIRECTORIES = new Set([
  ".next",
  "build",
  "coverage",
  "dist",
  "doc",
  "docs",
  "generated",
  "node_modules",
  "out",
  "pods",
  "target",
  "third_party",
  "vendor",
  "vendors",
]);

const EXCLUDED_FILENAMES = new Set([
  "bun.lock",
  "cargo.lock",
  "changelog",
  "changelog.md",
  "code_of_conduct.md",
  "composer.lock",
  "gemfile.lock",
  "license",
  "license.md",
  "package-lock.json",
  "pipfile.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "readme",
  "readme.md",
  "yarn.lock",
]);

function addCandidate(map: CandidateMap, key: string, language: string, primary: boolean): void {
  const candidates = map.get(key) ?? new Map<string, boolean>();
  candidates.set(language, (candidates.get(language) ?? false) || primary);
  map.set(key, candidates);
}

function chooseCandidate(candidates: Map<string, boolean> | undefined): string | null | "Other" {
  if (!candidates || candidates.size === 0) {
    return null;
  }
  const primary = [...candidates].filter(([, isPrimary]) => isPrimary).map(([language]) => language);
  if (primary.length === 1) {
    return primary[0] === EXCLUDED_CANDIDATE ? null : (primary[0] ?? "Other");
  }
  if (candidates.size > 1) {
    return "Other";
  }
  const candidate = [...candidates.keys()][0];
  return candidate === EXCLUDED_CANDIDATE ? null : (candidate ?? "Other");
}

export class LinguistClassifier {
  private constructor(
    private readonly extensions: CandidateMap,
    private readonly filenames: CandidateMap,
    private readonly colors: Map<string, string>,
  ) {}

  static async load(path: string): Promise<LinguistClassifier> {
    const source = await readFile(path, "utf8");
    const definitions = parse(source) as Record<string, LanguageDefinition>;
    const extensions: CandidateMap = new Map();
    const filenames: CandidateMap = new Map();
    const colors = new Map<string, string>();
    const included = new Set(
      Object.entries(definitions)
        .filter(([, definition]) => definition.type === "programming" || definition.type === "markup")
        .map(([name]) => name),
    );

    for (const [name, definition] of Object.entries(definitions)) {
      const canonical = included.has(name)
        ? definition.group && included.has(definition.group) ? definition.group : name
        : EXCLUDED_CANDIDATE;
      if (canonical !== EXCLUDED_CANDIDATE) {
        const canonicalDefinition = definitions[canonical];
        colors.set(canonical, canonicalDefinition?.color ?? definition.color ?? FALLBACK_LANGUAGE_COLOR);
      }
      for (const [index, extension] of (definition.extensions ?? []).entries()) {
        addCandidate(extensions, extension.toLowerCase(), canonical, index === 0);
      }
      for (const filename of definition.filenames ?? []) {
        addCandidate(filenames, filename.toLowerCase(), canonical, false);
      }
    }

    colors.set("Other", FALLBACK_LANGUAGE_COLOR);
    return new LinguistClassifier(extensions, filenames, colors);
  }

  static async loadDefault(): Promise<LinguistClassifier> {
    return LinguistClassifier.load(fileURLToPath(new URL("../../data/languages.yml", import.meta.url)));
  }

  classifyFiles(paths: string[]): string[] {
    const languages = new Set<string>();
    for (const path of paths) {
      const language = this.classifyFile(path);
      if (language) {
        languages.add(language);
      }
    }
    return [...languages].sort((left, right) => left.localeCompare(right));
  }

  colorFor(language: string): string {
    return this.colors.get(language) ?? FALLBACK_LANGUAGE_COLOR;
  }

  private classifyFile(path: string): string | null {
    const normalized = path.replaceAll("\\", "/");
    const parts = normalized.toLowerCase().split("/");
    const file = parts.at(-1) ?? "";
    if (parts.slice(0, -1).some((part) => EXCLUDED_DIRECTORIES.has(part))) {
      return null;
    }
    if (EXCLUDED_FILENAMES.has(file) || file.endsWith(".map") || /(?:\.min|\.generated|\.g)\.[^.]+$/.test(file)) {
      return null;
    }

    if (this.filenames.has(file)) {
      return chooseCandidate(this.filenames.get(file));
    }

    const suffixes = [...file.matchAll(/\./g)].map((match) => file.slice(match.index));
    for (const extension of suffixes) {
      if (this.extensions.has(extension)) {
        return chooseCandidate(this.extensions.get(extension));
      }
    }
    return null;
  }
}
