import { bindings, defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    "name": "infinitum-veil-web",
    "compatibilityDate": "2026-11-04",
    // public/ is served first; the Worker answers only POST /api/search (src/worker.js).
    "entrypoint": "./src/worker.js",
    "env": {
      // VEIL's own search index, filled by VEILBot (apps/veil-crawler).
      "VEIL_INDEX": bindings.d1({ name: "veil-index" }),
    },
    "observability": {
      "enabled": true
    }
  }
});
