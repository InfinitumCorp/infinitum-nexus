import { bindings, defineConfig, triggers } from "cf/config";

export default defineConfig({
  worker: {
    "name": "veil-crawler",
    "compatibilityDate": "2026-11-04",
    "entrypoint": "./src/index.js",
    "env": {
      // VEIL's search index and crawl queue (migrations/). infinitumveil.app reads it too.
      "VEIL_INDEX": bindings.d1({ name: "veil-index" }),
    },
    // One crawl round a minute (src/crawl.js). Set CRAWL_PAUSED=1 to stop crawling.
    "triggers": [triggers.scheduled({ schedule: "* * * * *" })],
    "observability": { "enabled": true },
  },
});
