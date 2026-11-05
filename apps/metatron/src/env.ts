/**
 * Builds the server from environment variables.
 *
 *   PORT                      default 3005
 *   PUBLIC_ORIGIN             e.g. https://metatron.example.com (Link page URL, Plaid webhook)
 *   METATRON_ALLOWED_ORIGINS  comma-separated browser origins allowed to call the API
 *   DATA_DIR                  default ./data (users.json, firmament.jsonl)
 *   METATRON_VAULT_KEY        32 random bytes, base64. Encrypts Plaid tokens and broker keys.
 *   FIRMAMENT_SIGNER_KEY      Ed25519 PKCS#8 base64, the ledger signing key
 *   PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV (sandbox|production), PLAID_COUNTRY_CODES, PLAID_REDIRECT_URI
 *   ALPACA_DATA_KEY_ID, ALPACA_DATA_SECRET   optional market data for the paper portfolio
 *   METATRON_APPROVAL_SESSION_MINUTES        default 60
 *   METATRON_DEV_TOKENS       local development only: "token:cid,..." (refused in production)
 *
 * In production, mount createApp() inside the host that runs Cumulus://ID (as Spectre does)
 * and pass cidAuth(cid), so METATRON accepts the same sign-in as every Infinitum product.
 */
import { join } from "node:path";
import { FileStore, Ledger, generateSigner, signerFromPrivateKey } from "@infinitum/firmament";
import { Vault } from "./vault.ts";
import { PlaidClient, type PlaidEnv } from "./plaid.ts";
import { AlpacaBroker } from "./broker.ts";
import { FileUserStore } from "./store.ts";
import { MetatronService } from "./service.ts";
import { devAuth, type Authenticate } from "./auth.ts";
import type { AppOptions } from "./server.ts";

export async function buildFromEnv(env: NodeJS.ProcessEnv, authenticate?: Authenticate): Promise<AppOptions & { plaidStatus: string }> {
  const prod = env.NODE_ENV === "production";
  const dataDir = env.DATA_DIR ?? join(import.meta.dirname, "..", "data");
  const publicOrigin = (env.PUBLIC_ORIGIN ?? `http://localhost:${env.PORT ?? 3005}`).replace(/\/$/, "");

  let vaultKey = env.METATRON_VAULT_KEY;
  if (!vaultKey) {
    if (prod) throw new Error("METATRON_VAULT_KEY is required in production");
    vaultKey = Vault.generateKey();
    console.warn("[metatron] No METATRON_VAULT_KEY: using a temporary key. Linked accounts won't survive a restart.");
  }

  let signer;
  if (env.FIRMAMENT_SIGNER_KEY) signer = signerFromPrivateKey(env.FIRMAMENT_SIGNER_KEY);
  else if (prod) throw new Error("FIRMAMENT_SIGNER_KEY is required in production");
  else signer = generateSigner();
  const ledger = new Ledger(new FileStore(join(dataDir, "firmament.jsonl")), { authorizedSigners: [signer.publicKey] });
  const check = await ledger.verify();
  if (!check.ok) throw new Error(`Firmament ledger failed verification at entry ${check.brokenAt}: ${check.reason}`);

  let plaid: PlaidClient | undefined, plaidStatus = "not configured";
  if (env.PLAID_CLIENT_ID && env.PLAID_SECRET) {
    plaid = new PlaidClient({
      clientId: env.PLAID_CLIENT_ID,
      secret: env.PLAID_SECRET,
      env: (env.PLAID_ENV ?? "sandbox") as PlaidEnv,
      countryCodes: (env.PLAID_COUNTRY_CODES ?? "US").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
      webhook: publicOrigin.startsWith("https://") ? `${publicOrigin}/webhooks/plaid` : undefined,
      redirectUri: env.PLAID_REDIRECT_URI || undefined,
    });
    plaidStatus = plaid.env;
  }

  const data = env.ALPACA_DATA_KEY_ID && env.ALPACA_DATA_SECRET ? new AlpacaBroker({ keyId: env.ALPACA_DATA_KEY_ID, secret: env.ALPACA_DATA_SECRET, paper: true }) : null;

  const service = new MetatronService({
    store: new FileUserStore(join(dataDir, "metatron-users.json")),
    ledger, signer, vault: new Vault(vaultKey), plaid,
    priceFeed: data ? (symbols) => data.latestPrices(symbols) : undefined,
  });

  const auth = authenticate ?? devAuth(env.METATRON_DEV_TOKENS);
  if (!auth) throw new Error("No sign-in configured. For local use set METATRON_DEV_TOKENS; in production mount createApp() in the Cumulus://ID host with cidAuth(cid).");

  return {
    service,
    authenticate: auth,
    allowedOrigins: (env.METATRON_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    publicOrigin,
    approvalMaxSessionAgeMinutes: Number(env.METATRON_APPROVAL_SESSION_MINUTES ?? 60),
    plaidStatus,
  };
}
