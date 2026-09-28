export type HostingEnvironment = "production" | "preview" | "development";

export interface HostingConfig {
  environment: HostingEnvironment;
  credentials: {
    githubToken: string | undefined;
    blobToken: string | undefined;
    cronSecret: string | undefined;
  };
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

/** Function 시작 시 환경과 선택적 Secret의 형식을 검사합니다. */
export function readHostingConfig(source: NodeJS.ProcessEnv): HostingConfig {
  const environment = source.VERCEL_ENV ?? "development";
  if (environment !== "production" && environment !== "preview" && environment !== "development") {
    throw new Error("Invalid VERCEL_ENV configuration.");
  }

  return {
    environment,
    credentials: {
      githubToken: optionalSecret(source, "GH_STATS_TOKEN"),
      blobToken: optionalSecret(source, "BLOB_READ_WRITE_TOKEN"),
      cronSecret: optionalSecret(source, "CRON_SECRET"),
    },
  };
}
