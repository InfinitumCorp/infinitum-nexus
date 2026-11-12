import { bindings, defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    name: "infinitum-veil-web",
    compatibilityDate: "2026-11-08",
    // Global users run on US servers (Ashburn, Virginia); Russia is served by the ru.* copies on Yandex Cloud.
    placement: { region: "gcp:us-east4" },
    // public/ is served first: the VEIL site at /, the start page and search at /start/.
    // The Worker answers only POST /api/search and POST /api/ask (src/worker.js).
    entrypoint: "./src/worker.js",
    assets: { notFoundHandling: "404-page", htmlHandling: "auto-trailing-slash" },
    domains: ["infinitumveil.app", "www.infinitumveil.app"],
    env: {
      // VEIL's own search index, filled by VEILBot (apps/veil-crawler).
      VEIL_INDEX: bindings.d1({ name: "veil-index" }),
      // Workers AI writes VEIL Answers (src/answer.js) from the pages VEIL found.
      AI: bindings.ai(),
      // The Android APK at /downloads/*.apk (src/worker.js), too big for a static asset. Private bucket.
      DOWNLOADS: bindings.r2({ name: "veil-downloads" }),
    },
    observability: { enabled: true },
  },
});
