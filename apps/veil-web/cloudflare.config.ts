import { bindings, defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    name: "infinitum-veil-web",
    compatibilityDate: "2026-11-08",
    // public/ is served first: the VEIL site at /, the start page and search at /start/.
    // The Worker answers only POST /api/search (src/worker.js).
    entrypoint: "./src/worker.js",
    assets: { notFoundHandling: "404-page", htmlHandling: "auto-trailing-slash" },
    domains: ["infinitumveil.app", "www.infinitumveil.app"],
    env: {
      // VEIL's own search index, filled by VEILBot (apps/veil-crawler).
      VEIL_INDEX: bindings.d1({ name: "veil-index" }),
    },
    observability: { enabled: true },
  },
});
