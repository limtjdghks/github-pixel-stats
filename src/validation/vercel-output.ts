import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

/**
 * 카드 렌더링·수집에 필요한 런타임 파일입니다. `src/render/shared.ts`(폰트)와
 * `src/data/linguist.ts`(Linguist 데이터)가 실행 중 읽으므로 `includeFiles`로 Function에 포함돼야 합니다.
 */
export const FUNCTION_RUNTIME_FILES = ["assets/fonts/NeoDunggeunmoPro.woff2", "data/languages.yml"] as const;

/**
 * `FUNCTION_RUNTIME_FILES`가 필요한 Function입니다. 카드는 bootstrap에서, Cron은 갱신에서 수집·렌더링합니다.
 * 검사 대상인 `vercel.json`의 `includeFiles` 유무로 판단하면 설정에서 빠진 경우를 잡지 못하므로 여기서 정합니다.
 */
export const FUNCTIONS_WITH_RUNTIME_FILES = ["api/card", "api/cron"] as const;

/** `vercel.json` 중 산출물 검사에 쓰는 부분입니다. */
export interface VercelProjectConfig {
  outputDirectory: string;
  functions: Record<string, unknown>;
  crons?: unknown;
}

/** `vercel build`가 만든 `.vercel/output`에서 읽은 검사 대상입니다. */
export interface VercelBuildOutput {
  /** 키는 `api/card`처럼 확장자 없는 Function 경로이고 값은 `filePathMap`에 연결된 포함 파일 경로입니다. */
  functions: Record<string, string[]>;
  staticFiles: string[];
  crons?: unknown;
}

const FUNCTION_CONFIG_SUFFIX = ".func/.vc-config.json";

/** 디렉터리 아래 모든 파일을 `/`로 구분한 상대 경로로 정렬해 반환합니다. */
export async function listRelativeFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
}

/** `.vercel/output`을 읽습니다. 디렉터리나 설정 파일이 없으면 파일 읽기 오류를 그대로 던집니다. */
export async function readVercelBuildOutput(outputDir: string): Promise<VercelBuildOutput> {
  const functionsDir = join(outputDir, "functions");
  const configPaths = (await listRelativeFiles(functionsDir)).filter((path) => path.endsWith(FUNCTION_CONFIG_SUFFIX));
  const functions: Record<string, string[]> = {};
  for (const configPath of configPaths) {
    const config = JSON.parse(await readFile(join(functionsDir, configPath), "utf8")) as { filePathMap?: Record<string, string> };
    functions[configPath.slice(0, -FUNCTION_CONFIG_SUFFIX.length)] = Object.keys(config.filePathMap ?? {}).sort();
  }
  const config = JSON.parse(await readFile(join(outputDir, "config.json"), "utf8")) as { crons?: unknown };
  return { functions, staticFiles: await listRelativeFiles(join(outputDir, "static")), crons: config.crons };
}

/**
 * `vercel build` 산출물이 배포 계약을 지키는지 검사해 어긋난 항목을 모두 반환합니다. 빈 배열이면 통과입니다.
 * `vercel.json`과 `FUNCTIONS_WITH_RUNTIME_FILES`의 Function이 모두 생성됐는지, 런타임 파일이 필요한 Function에 포함됐는지,
 * 정적 출력이 `outputDirectory`(`staticSourceFiles`)와 정확히 같은지, Cron 설정이 그대로 반영됐는지 확인합니다.
 */
export function findVercelOutputProblems(
  output: VercelBuildOutput,
  project: VercelProjectConfig,
  staticSourceFiles: readonly string[],
): string[] {
  const problems: string[] = [];
  const expectedFunctions = new Set([
    ...Object.keys(project.functions).map((source) => source.replace(/\.ts$/, "")),
    ...FUNCTIONS_WITH_RUNTIME_FILES,
  ]);
  for (const name of expectedFunctions) {
    if (!output.functions[name]) {
      problems.push(`Function ${name} is missing from the build output.`);
    }
  }
  for (const name of FUNCTIONS_WITH_RUNTIME_FILES) {
    const included = output.functions[name];
    // 생성되지 않은 Function은 위에서 보고했으므로 포함 파일 누락을 중복 보고하지 않습니다.
    if (!included) {
      continue;
    }
    for (const file of FUNCTION_RUNTIME_FILES) {
      if (!included.includes(file)) {
        problems.push(`Function ${name} does not include ${file}.`);
      }
    }
  }

  // 정적 출력은 공개 URL로 제공되므로 소스·fixture·데이터 파일이 섞이지 않도록 `outputDirectory`와 정확히 맞춥니다.
  const expectedStatic = new Set(staticSourceFiles);
  const actualStatic = new Set(output.staticFiles);
  for (const file of output.staticFiles) {
    if (!expectedStatic.has(file)) {
      problems.push(`Static output contains ${file}, which is not in ${project.outputDirectory}/.`);
    }
  }
  for (const file of staticSourceFiles) {
    if (!actualStatic.has(file)) {
      problems.push(`Static output is missing ${project.outputDirectory}/${file}.`);
    }
  }

  if (!isDeepStrictEqual(output.crons ?? [], project.crons ?? [])) {
    problems.push("Cron jobs in the build output differ from vercel.json.");
  }
  return problems;
}
