import { cardResponse } from "../src/hosting/card-response.js";
import { readHostingConfig } from "../src/hosting/environment.js";
import { createVercelBlobStores } from "../src/storage/vercel-blob-store.js";

const { blobStores } = readHostingConfig(process.env);
const stores = blobStores === undefined ? undefined : createVercelBlobStores(blobStores);

export default {
  fetch(request: Request): Promise<Response> {
    return cardResponse(request, stores);
  },
};
