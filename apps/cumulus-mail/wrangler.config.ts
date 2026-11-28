// Build settings for `cf deploy` (it delegates the build to Wrangler): the web app in ./public is
// uploaded as the Worker's static assets. Keep in step with worker.assets in cloudflare.config.ts.
import { defineWranglerConfig } from "wrangler/experimental-config";

export default defineWranglerConfig({
  assetsDirectory: "./public",
});
