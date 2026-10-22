import { readHostingConfig } from "../hosting/environment.js";
import { deleteUser, recentUsage, restoreUser, rollbackUser, serviceStatus } from "../hosting/operator.js";
import { createVercelBlobStores } from "../storage/vercel-blob-store.js";
import { parseOpsCommand } from "./ops-options.js";

/**
 * 운영 Blob store에 직접 접근하는 로컬 운영자 CLI입니다. `vercel env pull`로 받은 `VERCEL_OIDC_TOKEN`과
 * `BLOB_PRIVATE_STORE_ID`·`BLOB_PUBLIC_STORE_ID`를 환경 변수로 넘겨 실행합니다. 결과는 JSON으로 출력합니다.
 */
async function main(): Promise<void> {
  const command = parseOpsCommand(process.argv.slice(2));
  const { blobStores } = readHostingConfig(process.env);
  if (blobStores === undefined) {
    throw new Error("BLOB_PRIVATE_STORE_ID and BLOB_PUBLIC_STORE_ID are required.");
  }
  const stores = createVercelBlobStores(blobStores);
  const now = new Date();
  let result: unknown;
  switch (command.name) {
    case "status":
      result = await serviceStatus(stores.privateStore, now);
      break;
    case "usage":
      result = await recentUsage(stores.privateStore, now, command.days);
      break;
    case "delete":
      result = { applied: command.apply, ...(await deleteUser(stores, command.username, now, command.apply)) };
      break;
    case "restore":
      result = { restored: await restoreUser(stores.privateStore, command.username) };
      break;
    case "rollback":
      result = { applied: command.apply, ...(await rollbackUser(stores, command.username, now, command.apply)) };
      break;
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
