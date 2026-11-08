import { bindings, defineConfig, triggers } from "cf/config";

/**
 * Cumulus://Mail on Cloudflare Workers at mail.cumuluscloud.app, with Supabase (nexus-store) as the
 * back end. Deploy with `cf deploy --secrets-file <file>`; the secrets file holds
 * FIRMAMENT_SIGNER_KEY, NEXUS_STORE_URL and NEXUS_STORE_KEY.
 */
const host = "mail.cumuluscloud.app";

export default defineConfig({
  worker: {
    name: "cumulus-mail",
    entrypoint: "./src/worker.ts",
    compatibilityDate: "2026-11-01",
    compatibilityFlags: ["nodejs_compat"],
    domains: [host],
    observability: { enabled: true },
    triggers: [triggers.scheduled({ schedule: "* * * * *" })], // send scheduled mail that is due
    env: {
      MAIL_ORIGIN: bindings.text(`https://${host}`),
      // Mirror through AWS CloudFront for networks that throttle Cloudflare (Russian ISPs).
      MAIL_EXTRA_ORIGINS: bindings.text(`https://ru.${host}`),
      FIRMAMENT_SIGNER_KEY: bindings.secret(),
      NEXUS_STORE_URL: bindings.secret(),
      NEXUS_STORE_KEY: bindings.secret(),
    },
  },
});
