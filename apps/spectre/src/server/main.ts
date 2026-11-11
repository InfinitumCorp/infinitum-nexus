import { labyrinthFromEnvironment } from "@infinitum/lbrnth";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Ledger, FileStore, generateSigner, signerFromPrivateKey } from "@infinitum/firmament";
import { cookieDomainForHost, readCumulusDomain, socialFromEnv } from "@infinitum/cid";
import { createCumulus, emptyCumulusStores, loadCumulusStores, loadOrCreateMasterKey, saveCumulusStores } from "@infinitum/cumulus";
import { SpectreCRM, emptyStore } from "../core/crm.ts";
import { createApp } from "./app.ts";
import { veilFromEnv } from "@infinitum/veil/server";
import { aiConfigFromEnv } from "./ai.ts";
import { providersFromEnv } from "../core/messaging.ts";
import { saveSnapshot, loadSnapshot } from "./persist.ts";
import { loadGeoRouting } from "../geo-config.ts";

/**
 * Starts +SPCTR.
 *   PORT                 default 3000
 *   SPECTRE_ORIGIN       public origin for passkeys, default http://localhost:PORT
 *   CUMULUS_ROOT_DOMAIN  mail addresses, default cumuluscloud.app
 *   CUMULUS_ID_HOST      Cumulus://ID host, default id.cumuluscloud.app
 *   CUMULUS_KEYCLOAK_REALM Keycloak realm, default cumulus
 *                        issuer https://id.cumuluscloud.app/realms/cumulus
 *                        JWKS https://id.cumuluscloud.app/realms/cumulus/protocol/openid-connect/certs
 *   CUMULUS_CLOUD_HOST   Cumulus://Cloud, default cloud.cumuluscloud.app
 *   CUMULUS_MAIL_HOST    Cumulus://Mail, default mail.cumuluscloud.app
 *   CUMULUS_MAIL_ORIGIN  full mail URL in notices; default https://CUMULUS_MAIL_HOST
 *   SPECTRE_DATA_DIR     default ./data
 *   OMNIROUTE_API_KEY    enables AI features through OmniRoute (open-weight models); see
 *                        packages/ai/src/env.ts for backup hosts (Cloudflare Workers AI, Groq, ...)
 *   USE_METATRON         set to 1 (default) to use METATRON scorer
 *   Social sign-in (each optional; a provider appears only when its credentials are set):
 *     GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 *     GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET
 *     MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET
 *     APPLE_CLIENT_ID, APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY
 *     CHATGPT_CLIENT_ID, CHATGPT_CLIENT_SECRET, CHATGPT_ISSUER   (OpenAI partner program)
 *     COGNITO_DOMAIN, COGNITO_CLIENT_ID, COGNITO_CLIENT_SECRET, COGNITO_REGION, COGNITO_USER_POOL_ID
 *       Amazon Cognito user pool (Lite or Essentials). Off unless all five are set.
 *       Plus has no free MAU. Leave SMS MFA and SES email disabled; use TOTP if MFA is wanted.
 *   Callback URL to register with each provider: {SPECTRE_ORIGIN}/api/auth/oauth/{provider}/callback
 *   CID_OIDC_SIGNING_KEY private JWK (ES256 or Ed25519). Unset: OpenID Connect stays off.
 *                        node apps/spectre/scripts/generate-oidc-key.mjs writes the file and does not print the key.
 *                        See docs/cumulus-id.md.
 *   Conversations (each optional; without them messages are saved as drafts):
 *     RESEND_API_KEY, MAIL_FROM                         email
 *     TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM  SMS; inbound webhook: {SPECTRE_ORIGIN}/api/hooks/twilio/sms
 *   CRON_SECRET          lets an outside scheduler call POST /api/cron/automations (a local timer runs anyway)
 */

// Enable METATRON by default for advertised prediction performance.
process.env.USE_METATRON ??= "1";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 3000);
const origin = process.env.SPECTRE_ORIGIN ?? `http://localhost:${port}`;
const rpId = new URL(origin).hostname;
const cumulus = readCumulusDomain();
const dataDir = process.env.SPECTRE_DATA_DIR ?? join(here, "../../data");
loadGeoRouting(dataDir);
mkdirSync(dataDir, { recursive: true });

// The ledger signing key persists so the Firmament record stays verifiable across restarts.
const keyFile = join(dataDir, "firmament-signer.key");
let signer;
if (existsSync(keyFile)) signer = signerFromPrivateKey(readFileSync(keyFile, "utf8").trim());
else {
  signer = generateSigner();
  writeFileSync(keyFile, signer.exportPrivateKey());
  chmodSync(keyFile, 0o600);
}

const ledger = new Ledger(new FileStore(join(dataDir, "firmament.jsonl")), { authorizedSigners: [signer.publicKey] });
const verified = await ledger.verify();
if (!verified.ok) {
  console.error(`Firmament ledger failed verification at entry ${verified.brokenAt}: ${verified.reason}. Refusing to start.`);
  process.exit(1);
}

// cid.json keeps its old name; mail, wallet, quota and suite sit next to it.
const cumulusStores = loadCumulusStores(dataDir, emptyCumulusStores());
const cidStore = cumulusStores.cid;
const spectreStore = loadSnapshot(join(dataDir, "spectre.json"), emptyStore());
// Social sign-in available to every Infinitum product that uses Cumulus://ID.
const social = socialFromEnv();

// Every CID that signs up through +SPCTR gets the full Cumulus account: Mail, Cloud and a FIRM Wallet.
const suite = createCumulus({
  labyrinth: labyrinthFromEnvironment(process.env, process.env.LBRNTH_SNAPSHOT_FILE ?? join(dataDir, "labyrinth.json")),
  ledger, signer, rpId, origins: [origin], stores: cumulusStores, social: { providers: social },
  mailOrigin: process.env.CUMULUS_MAIL_ORIGIN ?? cumulus.mailOrigin,
  masterKey: loadOrCreateMasterKey(dataDir),
});
suite.provisionAll();
const cid = suite.cid;
const crm = new SpectreCRM({ ledger, signer, store: spectreStore });

const ai = aiConfigFromEnv();
const app = createApp({
  cid,
  suite,
  crm,
  ai,
  publicDir: join(here, "../../public"),
  secureCookies: origin.startsWith("https://"),
  cookieDomain: cookieDomainForHost(new URL(origin).hostname, cumulus.cookieDomain),
  origin,
  providers: providersFromEnv(),
  cronSecret: process.env.CRON_SECRET,
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN,
  veil: veilFromEnv(process.env),
  onChange: () => {
    saveCumulusStores(dataDir, cumulusStores, { tunnel: suite.tunnel });
    saveSnapshot(join(dataDir, "spectre.json"), spectreStore);
  },
});

const server = app.server();
server.listen(port, () => {
  console.log(`+SPCTR running at ${origin}  (ledger: ${verified.length} verified entries, AI: ${ai.router?.connected ? `open models via ${ai.router.providers.join(" → ")}` : "not connected"}, METATRON: ${process.env.USE_METATRON === "1" ? "on" : "off"}, sign-in: passkey${Object.keys(social).map((p) => ", " + p).join("")})`);
});

// Resume automation steps whose wait is over.
setInterval(() => void app.runDueAutomations().catch((err) => console.error("automations:", err)), 60_000).unref();

// Finish active requests before a container restart or operator stop.
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close(() => process.exit(0));
  setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 25_000).unref();
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
