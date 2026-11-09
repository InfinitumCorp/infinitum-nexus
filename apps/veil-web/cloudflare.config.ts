import { defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    "name": "infinitum-veil-web",
    "compatibilityDate": "2026-11-04",
    "observability": {
      "enabled": true
    }
  }
});
