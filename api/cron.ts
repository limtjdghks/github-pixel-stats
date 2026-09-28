import { readHostingConfig } from "../src/hosting/environment.js";
import { unavailableResponse } from "../src/hosting/http.js";

readHostingConfig(process.env);

export default {
  fetch(request: Request): Response {
    return unavailableResponse(request, "cron");
  },
};
