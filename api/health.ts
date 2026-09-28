import { readHostingConfig } from "../src/hosting/environment.js";
import { healthResponse } from "../src/hosting/http.js";

readHostingConfig(process.env);

export default {
  fetch(request: Request): Response {
    return healthResponse(request);
  },
};
