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
      // Mirror through AWS CloudFront for networks that throttle Cloudflare (Russian ISPs).
      MAIL_EXTRA_ORIGINS: bindings.text(`https://ru.${host}`),
      FIRMAMENT_SIGNER_KEY: bindings.secret(),
      NEXUS_STORE_URL: bindings.secret(),
      NEXUS_STORE_KEY: bindings.secret(),
      // Bindings the live Worker carries; a deploy that leaves one out removes it.
      DOWNLOADS_SITE: bindings.worker({ worker: "cumulus-downloads" }), // serves /download/
      MAIL_FILES: bindings.r2({ name: "cumulus-mail-files" }), // attachments
      EMAIL: bindings.sendEmail(), // outside mail through Cloudflare Email Sending
      GOOGLE_CLIENT_ID: bindings.secret(),
      GOOGLE_CLIENT_SECRET: bindings.secret(),
    },
  },
});
