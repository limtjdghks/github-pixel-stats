import type { BlobStoreIds } from "../storage/vercel-blob-store.js";

export type HostingEnvironment = "production" | "preview" | "development";

export interface HostingConfig {
  environment: HostingEnvironment;
  credentials: {
    githubToken: string | undefined;
    cronSecret: string | undefined;
  };
  /** Blob 인증은 Vercel OIDC로 하므로 store ID만 설정합니다. 둘 다 없으면 undefined입니다. */
  blobStores: BlobStoreIds | undefined;
}

function optionalSecret(source: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = source[key];
  if (value === undefined) {
    return undefined;
  }
  if (value.trim().length === 0) {
    throw new Error(`Invalid ${key} configuration.`);
  }
  return value;
}

function readBlobStores(source: NodeJS.ProcessEnv): BlobStoreIds | undefined {
  const privateStoreId = optionalSecret(source, "BLOB_PRIVATE_STORE_ID")?.trim();
  const publicStoreId = optionalSecret(source, "BLOB_PUBLIC_STORE_ID")?.trim();
  if (privateStoreId === undefined && publicStoreId === undefined) {
    return undefined;
  }
  // 한쪽만 있거나 같은 store를 가리키면 private 상태가 public store에 쓰일 수 있습니다.
  if (privateStoreId === undefined || publicStoreId === undefined || privateStoreId === publicStoreId) {
    throw new Error("Invalid Blob store configuration.");
  }
  return { privateStoreId, publicStoreId };
}

/** Function 시작 시 환경과 선택적 Secret·Blob store 설정의 형식을 검사합니다. */
export function readHostingConfig(source: NodeJS.ProcessEnv): HostingConfig {
  const environment = source.VERCEL_ENV ?? "development";
  if (environment !== "production" && environment !== "preview" && environment !== "development") {
    throw new Error("Invalid VERCEL_ENV configuration.");
  }

  return {
    environment,
    credentials: {
      githubToken: optionalSecret(source, "GH_STATS_TOKEN"),
      cronSecret: optionalSecret(source, "CRON_SECRET"),
    },
    blobStores: readBlobStores(source),
  };
}
