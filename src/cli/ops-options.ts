import { parseUsername } from "../username.js";

export type OpsCommand =
  | { name: "status" }
  | { name: "usage"; days: number }
  | { name: "delete" | "rollback"; username: string; apply: boolean }
  | { name: "restore"; username: string };

const USAGE_DAYS = { default: 7, max: 90 } as const;
const HELP = "Usage: npm run ops -- status | usage [--days N] | delete <user> [--yes] | restore <user> | rollback <user> [--yes]";

/**
 * 운영자 CLI 인자를 해석합니다. 삭제·rollback은 `--yes`가 있어야 저장소를 바꾸며, 없으면 바뀔 내용만 출력합니다.
 * 알 수 없는 명령·인자나 잘못된 사용자명은 사용법과 함께 던집니다.
 */
export function parseOpsCommand(argv: readonly string[]): OpsCommand {
  const [name, ...rest] = argv;
  const flags = rest.filter((arg) => arg.startsWith("--"));
  const positional = rest.filter((arg, index) => !arg.startsWith("--") && rest[index - 1] !== "--days");
  const fail = (reason: string): never => {
    throw new Error(`${reason}\n${HELP}`);
  };
  const onlyFlags = (allowed: readonly string[]) => {
    for (const flag of flags) if (!allowed.includes(flag)) fail(`Unknown option: ${flag}.`);
  };
  const username = (): string => {
    if (positional.length !== 1) fail("Exactly one GitHub username is required.");
    return parseUsername(positional[0]!);
  };
  switch (name) {
    case "status":
      onlyFlags([]);
      if (positional.length > 0) fail("status takes no arguments.");
      return { name };
    case "usage": {
      onlyFlags(["--days"]);
      if (positional.length > 0) fail("usage takes no positional arguments.");
      const index = rest.indexOf("--days");
      const days = index === -1 ? USAGE_DAYS.default : Number(rest[index + 1]);
      if (!Number.isSafeInteger(days) || days < 1 || days > USAGE_DAYS.max) fail(`--days must be 1 to ${USAGE_DAYS.max}.`);
      return { name, days };
    }
    case "delete":
    case "rollback":
      onlyFlags(["--yes"]);
      return { name, username: username(), apply: flags.includes("--yes") };
    case "restore":
      onlyFlags([]);
      return { name, username: username() };
    default:
      return fail(name === undefined ? "A command is required." : `Unknown command: ${name}.`);
  }
}
