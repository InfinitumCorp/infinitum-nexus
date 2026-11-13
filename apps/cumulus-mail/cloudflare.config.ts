import { bindings, defineConfig, triggers } from "cf/config";

/**
 * Cumulus://Mail on Cloudflare Workers at mail.cumuluscloud.app, with Supabase (nexus-store) as the
 * back end. Deploy with `cf deploy --secrets-file <file>`; the secrets file holds
 * FIRMAMENT_SIGNER_KEY, NEXUS_STORE_URL and NEXUS_STORE_KEY.
 *
 * Mail to outside addresses goes out through Cloudflare Email Sending: the zone is onboarded
 * (`wrangler email sending enable cumuluscloud.app`) and the Worker needs a send_email binding
 * named EMAIL (`"send_email": [{ "name": "EMAIL" }]`). Without it, outside mail stays queued.
 *
 * Optional sign-in providers, set as Worker secrets (`wrangler secret put NAME`). Each provider's
 * "Continue with …" button appears on the sign-in page once its secrets are set; no deploy needed.
 *   Google: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 *   Apple:  APPLE_CLIENT_ID (the Services ID), APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY (.p8 contents)
 * Callback URLs to register with the provider: https://mail.cumuluscloud.app/api/auth/oauth/{google|apple}/callback
 */
const host = "mail.cumuluscloud.app";

export default defineConfig({
  worker: {
    name: "cumulus-mail",
    entrypoint: "./src/worker.ts",
    compatibilityDate: "2026-11-01",
    // Global users run on US servers (Ashburn, Virginia); Russia is served by the ru.* copies on Yandex Cloud.
    placement: { region: "gcp:us-east4" },
    compatibilityFlags: ["nodejs_compat"],
    domains: [host],
    // The web app (public/: index.html, app.js, manifest, sw.js…) is served as static assets; the
    // directory comes from wrangler.config.ts. Without this block a `cf deploy` uploads only the
    // Worker code and / answers 404 (as happened on 2026-11-10). Same settings the wrangler
    // deploys used: files first, then the Worker; no SPA fallback.
    assets: { htmlHandling: "auto-trailing-slash", notFoundHandling: "none" },
    observability: { enabled: true },
    triggers: [triggers.scheduled({ schedule: "* * * * *" })], // send scheduled mail that is due
    env: {
      MAIL_ORIGIN: bindings.text(`https://${host}`),
      // Mirrors for networks that throttle Cloudflare (Russian ISPs): ru. is AWS (also throttled in
      // Russia since 2026-11); ru2. is Firebase Hosting -> Cloud Run (mirror/), which gets through.
      MAIL_EXTRA_ORIGINS: bindings.text(`https://ru.${host},https://ru2.${host}`),
      // Cumulus://ID as rows in Supabase through nexus-store (no database password); see
      // apps/spectre/src/server/cid-store.ts and docs/plans/relational-storage.md. Set back to
      // "document" to roll back. Needs supabase/migrations/20261113_cumulus_id_rows.sql applied and the
      // updated nexus-store edge function deployed first, and cumulus_id.refresh_from_document() run
      // right before this deploy goes live.
      CUMULUS_STORE: bindings.text("gateway"),
      // Infinitum Search (POST /api/web-search) on VEIL's own engine; needs no key.
      VEIL_SEARCH_URL: bindings.text("https://infinitumveil.app/api/search"),
      FIRMAMENT_SIGNER_KEY: bindings.secret(),
      NEXUS_STORE_URL: bindings.secret(),
      NEXUS_STORE_KEY: bindings.secret(),
      // Already on the live Worker; declared here so a deploy keeps them.
      EMAIL: bindings.sendEmail(),
      MAIL_FILES: bindings.r2({ name: "cumulus-mail-files" }),
      DOWNLOADS_SITE: bindings.worker({ worker: "cumulus-downloads" }),
      // US Labyrinth (Worker lbrnth-host-us), reached Worker-to-Worker so Cloudflare Access never applies.
      LBRNTH_US: bindings.worker({ worker: "lbrnth-host-us" }),
      GOOGLE_CLIENT_ID: bindings.secret(),
      GOOGLE_CLIENT_SECRET: bindings.secret(),
      // Hosted Labyrinth relay target (https://<cloud-run-host>/api/labyrinth), set with wrangler secret put.
      LBRNTH_ENDPOINT: bindings.secret(),
    },
  },
});
