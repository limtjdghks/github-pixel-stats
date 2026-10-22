import { readFile } from "node:fs/promises";
import {
  findVercelOutputProblems,
  listRelativeFiles,
  readVercelBuildOutput,
  type VercelProjectConfig,
} from "../validation/vercel-output.js";

async function main(): Promise<void> {
  const project = JSON.parse(await readFile("vercel.json", "utf8")) as VercelProjectConfig;
  const [output, staticSourceFiles] = await Promise.all([
    readVercelBuildOutput(".vercel/output"),
    listRelativeFiles(project.outputDirectory),
  ]);
  const problems = findVercelOutputProblems(output, project, staticSourceFiles);
  if (problems.length > 0) {
    throw new Error(`Vercel build output is invalid:\n- ${problems.join("\n- ")}`);
  }
  console.log(`Vercel build output is valid (${Object.keys(output.functions).length} functions, ${output.staticFiles.length} static files).`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
