import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  findVercelOutputProblems,
  FUNCTION_RUNTIME_FILES,
  readVercelBuildOutput,
  type VercelBuildOutput,
  type VercelProjectConfig,
} from "../src/validation/vercel-output.js";

const project = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8")) as VercelProjectConfig;

function validOutput(): VercelBuildOutput {
  return {
    functions: {
      "api/health": [],
      "api/card": [...FUNCTION_RUNTIME_FILES],
      "api/cron": [...FUNCTION_RUNTIME_FILES],
    },
    staticFiles: ["404.html"],
    crons: structuredClone(project.crons),
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

async function createOutputDir(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "gps-vercel-output-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("a build output matching vercel.json and public/ has no problems", () => {
  assert.deepEqual(findVercelOutputProblems(validOutput(), project, ["404.html"]), []);
});

test("a function without the font or Linguist data is reported", () => {
  const output = validOutput();
  output.functions["api/cron"] = ["data/languages.yml"];
  assert.deepEqual(findVercelOutputProblems(output, project, ["404.html"]), [
    "Function api/cron does not include assets/fonts/NeoDunggeunmoPro.woff2.",
  ]);
});

test("runtime files are still required when includeFiles is removed from vercel.json", () => {
  const withoutIncludeFiles: VercelProjectConfig = {
    ...project,
    functions: Object.fromEntries(Object.keys(project.functions).map((source) => [source, {}])),
  };
  const output = validOutput();
  output.functions["api/card"] = [];
  assert.deepEqual(findVercelOutputProblems(output, withoutIncludeFiles, ["404.html"]), [
    "Function api/card does not include assets/fonts/NeoDunggeunmoPro.woff2.",
    "Function api/card does not include data/languages.yml.",
  ]);
});

test("a runtime-file function missing from both vercel.json and the output is reported once", () => {
  const withoutCron: VercelProjectConfig = {
    ...project,
    functions: Object.fromEntries(Object.entries(project.functions).filter(([source]) => source !== "api/cron.ts")),
  };
  const output = validOutput();
  delete output.functions["api/cron"];
  assert.deepEqual(findVercelOutputProblems(output, withoutCron, ["404.html"]), [
    "Function api/cron is missing from the build output.",
  ]);
});

test("a function declared in vercel.json but absent from the output is reported", () => {
  const output = validOutput();
  delete output.functions["api/card"];
  assert.deepEqual(findVercelOutputProblems(output, project, ["404.html"]), [
    "Function api/card is missing from the build output.",
  ]);
});

test("static files outside public/ and missing public files are both reported", () => {
  const output = validOutput();
  output.staticFiles = ["data/languages.yml", "src/config.ts"];
  assert.deepEqual(findVercelOutputProblems(output, project, ["404.html"]), [
    "Static output contains data/languages.yml, which is not in public/.",
    "Static output contains src/config.ts, which is not in public/.",
    "Static output is missing public/404.html.",
  ]);
});

test("cron jobs that differ from vercel.json are reported", () => {
  const output = validOutput();
  output.crons = [{ path: "/api/cron", schedule: "0 * * * *" }];
  assert.deepEqual(findVercelOutputProblems(output, project, ["404.html"]), [
    "Cron jobs in the build output differ from vercel.json.",
  ]);
});

test("readVercelBuildOutput reads function file maps, nested static files and crons", async (t) => {
  const directory = await createOutputDir(t);
  const crons = [{ path: "/api/cron", schedule: "17 18 * * *" }];
  await writeJson(join(directory, "config.json"), { version: 3, routes: [], crons });
  await writeJson(join(directory, "functions/api/card.func/.vc-config.json"), {
    handler: "api/card.js",
    filePathMap: { "data/languages.yml": "data/languages.yml", "assets/fonts/NeoDunggeunmoPro.woff2": "assets/fonts/NeoDunggeunmoPro.woff2" },
  });
  await writeJson(join(directory, "functions/api/health.func/.vc-config.json"), { handler: "api/health.js" });
  await mkdir(join(directory, "static/nested"), { recursive: true });
  await writeFile(join(directory, "static/404.html"), "");
  await writeFile(join(directory, "static/nested/page.html"), "");

  assert.deepEqual(await readVercelBuildOutput(directory), {
    functions: {
      "api/card": ["assets/fonts/NeoDunggeunmoPro.woff2", "data/languages.yml"],
      "api/health": [],
    },
    staticFiles: ["404.html", "nested/page.html"],
    crons,
  });
});
