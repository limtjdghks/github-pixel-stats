import { getDeadline } from "@vercel/functions";
import { cronResponse } from "../src/hosting/cron-response.js";
import { cronLimits } from "../src/hosting/cron-run.js";
import { readHostingConfig } from "../src/hosting/environment.js";
import { createRefreshDependencies } from "../src/hosting/refresh-dependencies.js";
import { createVercelBlobStores } from "../src/storage/vercel-blob-store.js";

const { blobStores, credentials } = readHostingConfig(process.env);
const dependencies = blobStores === undefined || credentials.githubToken === undefined
  ? undefined
  : createRefreshDependencies(createVercelBlobStores(blobStores), credentials.githubToken);

export default {
  fetch(request: Request): Promise<Response> {
    return cronResponse(request, { secret: credentials.cronSecret, dependencies }, () => cronLimits(new Date(), getDeadline()));
  },
};
