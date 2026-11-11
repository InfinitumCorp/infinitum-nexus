import type { IncomingMessage, ServerResponse } from "node:http";
import { Ledger, signerFromPrivateKey } from "@infinitum/firmament";
import { socialFromEnv } from "@infinitum/cid";
import { createCumulus, emptyCumulusStores } from "@infinitum/cumulus";
import { SpectreCRM, emptyStore } from "../core/crm.ts";
import { createApp } from "./app.ts";
import { aiConfigFromEnv } from "./ai.ts";
import { providersFromEnv } from "../core/messaging.ts";
import { RemoteState, HttpGateway, type NexusGateway } from "./remote.ts";

/**
 * +SPCTR on Vercel (serverless). All data lives in Supabase behind the private
 * nexus-store function; each request loads the latest state and saves atomically.
 *
 * Required environment variables:
 *   SPECTRE_ORIGIN         public URL, e.g. https://spectre.example.com (passkeys are bound to it)
 *   FIRMAMENT_SIGNER_KEY   base64 PKCS#8 Ed25519 key that signs ledger entries (keep secret)
 *   NEXUS_STORE_URL        https://<project>.supabase.co/functions/v1/nexus-store
 *   NEXUS_STORE_KEY        gateway key; its SHA-256 is listed in nexus_gateway_keys
 * Optional: OMNIROUTE_API_KEY (or another open-model host), USE_METATRON, CUMULUS_ROOT_DOMAIN, CUMULUS_ID_HOST,
 * CUMULUS_KEYCLOAK_REALM, CUMULUS_CLOUD_HOST, CUMULUS_MAIL_HOST, CUMULUS_MAIL_ORIGIN,
 * and the social sign-in variables (see main.ts). CID_OIDC_SIGNING_KEY is optional; when it is
 * unset, OpenID Connect stays off and sign-in still works. See docs/cumulus-id.md.
 */

process.env.USE_METATRON ??= "1";

/** import.meta.url is not a URL inside a Workers bundle; static files never come from here there. */
function publicDir(): string {
  try {
    return new URL("./public/", import.meta.url).pathname;
  } catch {
    return "/public/";
  }
}

let gatewayOverride: NexusGateway | undefined;
/**
 * Keep state somewhere other than the nexus-store function (the Cloudflare Worker passes a
 * Durable Object). Call before the first request. NEXUS_STORE_URL/KEY are then not needed.
 */
export function useGateway(gateway: NexusGateway) {
  gatewayOverride = gateway;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

function build() {
  const origin = required("SPECTRE_ORIGIN").replace(/\/$/, "");
  const signer = signerFromPrivateKey(required("FIRMAMENT_SIGNER_KEY"));
  const cumulusStores = emptyCumulusStores();
  const spectreStore = emptyStore();
  // The CID, Mail, Wallet and quota docs are shared by every hosted Infinitum product,
  // so an account made here has the same mailbox and wallet in Cumulus://Mail.
  const gateway = gatewayOverride ?? new HttpGateway(required("NEXUS_STORE_URL"), required("NEXUS_STORE_KEY"));
  const state = new RemoteState(gateway, {
    cid: cumulusStores.cid,
    spectre: spectreStore,
    "cumulus-mail": cumulusStores.mail,
    "firm-wallet": cumulusStores.wallet,
    "cumulus-quota": cumulusStores.quota,
    "cumulus-suite": cumulusStores.suite,
  });
  const ledger = new Ledger(state.ledgerStore, { authorizedSigners: [signer.publicKey] });
  const suite = createCumulus({
    ledger, signer, rpId: new URL(origin).hostname, origins: [origin], stores: cumulusStores,
    social: { providers: socialFromEnv() }, mailOrigin: process.env.CUMULUS_MAIL_ORIGIN,
  });
  const cid = suite.cid;
  const crm = new SpectreCRM({ ledger, signer, store: spectreStore });

  // Refuse to serve if the stored ledger fails verification (tampering or a wrong signing key).
  let verified: Promise<void> | undefined;
  const verifyOnce = () =>
    (verified ??= (async () => {
      await state.sync();
      const result = await ledger.verify();
      if (!result.ok) throw new Error(`Firmament ledger failed verification at entry ${result.brokenAt}: ${result.reason}`);
    })().catch((err) => {
      verified = undefined; // try again on the next request
      throw err;
    }));

  const app = createApp({
    cid,
    suite,
    crm,
    ai: aiConfigFromEnv(),
    publicDir: publicDir(), // static files are served by the CDN (Vercel) or Workers static assets
    secureCookies: origin.startsWith("https://"),
    origin,
    providers: providersFromEnv(),
    cronSecret: process.env.CRON_SECRET,
    twilioAuthToken: process.env.TWILIO_AUTH_TOKEN,
    transaction: async (fn) => {
      await verifyOnce();
      return state.transaction(fn);
    },
  });
  return app;
}

let app: ReturnType<typeof build> | undefined;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    app ??= build();
  } catch (err) {
    console.error(err);
    res.writeHead(503, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: "+SPCTR isn't configured yet. Please try again later." }));
    return;
  }
  await app.handle(req, res);
}
