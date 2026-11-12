import { getDeadline, waitUntil } from "@vercel/functions";
import { BOOTSTRAP_BUDGET_MS, bootstrapUser } from "../src/hosting/bootstrap.js";
import { cardResponse } from "../src/hosting/card-response.js";
import { readHostingConfig } from "../src/hosting/environment.js";
import { boundedDeadline } from "../src/hosting/invocation-deadline.js";
import { createRefreshDependencies } from "../src/hosting/refresh-dependencies.js";
import { createVercelBlobStores } from "../src/storage/vercel-blob-store.js";

/** Function 종료 직전에 bootstrap이 끝나도록 남겨 두는 시간입니다. */
const BOOTSTRAP_DEADLINE_MARGIN_MS = 2_000;

const { blobStores, credentials } = readHostingConfig(process.env);
const stores = blobStores === undefined ? undefined : createVercelBlobStores(blobStores);
const refresh = stores === undefined || credentials.githubToken === undefined
  ? undefined
  : createRefreshDependencies(stores, credentials.githubToken);

export default {
  fetch(request: Request): Promise<Response> {
    return cardResponse(request, stores, refresh === undefined ? {} : {
      onPending: (username) => {
        const deadline = boundedDeadline(new Date(), BOOTSTRAP_BUDGET_MS, getDeadline(), BOOTSTRAP_DEADLINE_MARGIN_MS);
        waitUntil(bootstrapUser(username, deadline, refresh));
      },
    });
  },
};
