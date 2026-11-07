import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Ledger, FileStore, generateSigner, signerFromPrivateKey } from "@infinitum/firmament";
import { cookieDomainForHost, readCumulusDomain, socialFromEnv } from "@infinitum/cid";
import { createCumulus, emptyCumulusStores, loadCumulusStores, loadOrCreateMasterKey, saveCumulusStores } from "@infinitum/cumulus";
import { SpectreCRM, emptyStore } from "../core/crm.ts";
import { createApp } from "./app.ts";
import { aiConfigFromEnv } from "./ai.ts";
import { providersFromEnv } from "../core/messaging.ts";
import { saveSnapshot, loadSnapshot } from "./persist.ts";

/**
 * Starts +SPCTR.
 *   PORT                 default 3000
 *   SPECTRE_ORIGIN       public origin for passkeys, default http://localhost:PORT
 *   SPECTRE_DATA_DIR     default ./data
 *   ANTHROPIC_API_KEY    enables AI features
 *   USE_METATRON         set to 1 (default) to use METATRON scorer
 *   Social sign-in (each optional; a provider appears only when its credentials are set):
 *     GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 *     GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET
 *     MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET
 *     APPLE_CLIENT_ID, APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY
 *     CHATGPT_CLIENT_ID, CHATGPT_CLIENT_SECRET, CHATGPT_ISSUER   (OpenAI partner program)
 *   Callback URL to register with each provider: {SPECTRE_ORIGIN}/api/auth/oauth/{provider}/callback
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
  onChange: () => {
    saveCumulusStores(dataDir, cumulusStores, { tunnel: suite.tunnel });
    saveSnapshot(join(dataDir, "spectre.json"), spectreStore);
  },
});

app.server().listen(port, () => {
  console.log(`+SPCTR running at ${origin}  (ledger: ${verified.length} verified entries, AI: ${ai.apiKey ? "connected" : "not connected"}, METATRON: ${process.env.USE_METATRON === "1" ? "on" : "off"}, sign-in: passkey${Object.keys(social).map((p) => ", " + p).join("")})`);
});

// Resume automation steps whose wait is over.
setInterval(() => void app.runDueAutomations().catch((err) => console.error("automations:", err)), 60_000).unref();
