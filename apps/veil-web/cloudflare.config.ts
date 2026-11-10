import { defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    "name": "infinitum-veil-web",
    "compatibilityDate": "2026-11-04",
    // public/ is served first; the Worker answers only POST /api/search (src/worker.js).
    "entrypoint": "./src/worker.js",
    "observability": {
      "enabled": true
    }
  }
});
