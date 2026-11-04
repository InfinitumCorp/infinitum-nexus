import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Ledger, FileStore, generateSigner, signerFromPrivateKey } from "@infinitum/firmament";
import { CidService, CidStore, type SocialCredentials } from "@infinitum/cid";
import { SpectreCRM, emptyStore } from "../core/crm.ts";
import { createApp } from "./app.ts";
import { aiConfigFromEnv } from "./ai.ts";
import { saveSnapshot, loadSnapshot } from "./persist.ts";

/**
 * Starts +SPCTR.
 *   PORT                 default 3000
 *   SPECTRE_ORIGIN       public origin for passkeys, default http://localhost:PORT
 *   SPECTRE_DATA_DIR     default ./data
 *   ANTHROPIC_API_KEY    enables AI features
 *   Social sign-in (each optional; a provider appears only when its credentials are set):
 *     GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 *     GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET
 *     MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET
 *     APPLE_CLIENT_ID, APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY
 *     CHATGPT_CLIENT_ID, CHATGPT_CLIENT_SECRET, CHATGPT_ISSUER   (OpenAI partner program)
 *   Callback URL to register with each provider: {SPECTRE_ORIGIN}/api/auth/oauth/{provider}/callback
 */

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 3000);
const origin = process.env.SPECTRE_ORIGIN ?? `http://localhost:${port}`;
const rpId = new URL(origin).hostname;
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

const cidStore = loadSnapshot(join(dataDir, "cid.json"), new CidStore());
const spectreStore = loadSnapshot(join(dataDir, "spectre.json"), emptyStore());
// Social sign-in: each provider is offered only when its credentials are set.
const env = process.env;
const social: Record<string, SocialCredentials> = {};
if (env.GOOGLE_CLIENT_ID) social.google = { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
if (env.GITHUB_CLIENT_ID) social.github = { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET };
if (env.MICROSOFT_CLIENT_ID) social.microsoft = { clientId: env.MICROSOFT_CLIENT_ID, clientSecret: env.MICROSOFT_CLIENT_SECRET };
if (env.APPLE_CLIENT_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY) {
  social.apple = { clientId: env.APPLE_CLIENT_ID, apple: { teamId: env.APPLE_TEAM_ID, keyId: env.APPLE_KEY_ID, privateKeyPem: env.APPLE_PRIVATE_KEY.replace(/\\n/g, "\n") } };
}
if (env.CHATGPT_CLIENT_ID && env.CHATGPT_ISSUER) {
  social.chatgpt = { clientId: env.CHATGPT_CLIENT_ID, clientSecret: env.CHATGPT_CLIENT_SECRET, issuer: env.CHATGPT_ISSUER };
}

const cid = new CidService({ ledger, signer, rpId, origins: [origin], store: cidStore, social: { providers: social } });
const crm = new SpectreCRM({ ledger, signer, store: spectreStore });

const ai = aiConfigFromEnv();
const app = createApp({
  cid,
  crm,
  ai,
  publicDir: join(here, "../../public"),
  secureCookies: origin.startsWith("https://"),
  origin,
  onChange: () => {
    saveSnapshot(join(dataDir, "cid.json"), cidStore);
    saveSnapshot(join(dataDir, "spectre.json"), spectreStore);
  },
});

app.server().listen(port, () => {
  console.log(`+SPCTR running at ${origin}  (ledger: ${verified.length} verified entries, AI: ${ai.apiKey ? "connected" : "not connected"}, sign-in: passkey${Object.keys(social).map((p) => ", " + p).join("")})`);
});
