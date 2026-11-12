import { labyrinthFromEnvironment } from "@infinitum/lbrnth";
/**
 * Cumulus://Mail.
 * Run: node --experimental-strip-types src/server.ts
 *
 *   PORT             default 3010
 *   MAIL_ORIGIN      public origin (passkeys are bound to it), default http://localhost:PORT
 *                    Production is https://mail.cumuluscloud.app (CUMULUS_MAIL_ORIGIN).
 *   MAIL_DATA_DIR    default ./data
 *   OMNIROUTE_API_KEY turns on SCALVS briefs and Clean suggestions on open-weight models
 *                    (backup hosts: packages/ai/src/env.ts)
 *   CUMULUS_MAIL_MASTER_KEY  base64 32-byte Cumulus Tunnel master key (otherwise data/tunnel-master.key)
 *   Social sign-in variables, as in +SPCTR (GOOGLE_CLIENT_ID, ...). Callback:
 *   {MAIL_ORIGIN}/api/auth/oauth/{provider}/callback
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { Ledger, FileStore, generateSigner, signerFromPrivateKey } from "@infinitum/firmament";
import { cookieDomainForHost, readCumulusDomain, socialFromEnv, upstreamIssuerFromEnv } from "@infinitum/cid";
import { createCumulus, emptyCumulusStores, loadCumulusStores, loadOrCreateMasterKey, saveCumulusStores } from "@infinitum/cumulus";
import { createMailApp } from "./app.ts";

const port = Number(process.env.PORT ?? 3010);
const cumulus = readCumulusDomain();
const origin = (process.env.MAIL_ORIGIN ?? `http://localhost:${port}`).replace(/\/$/, "");
const dataDir = process.env.MAIL_DATA_DIR ?? join(import.meta.dirname, "..", "data");
mkdirSync(dataDir, { recursive: true });

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

const stores = loadCumulusStores(dataDir, emptyCumulusStores());
const social = socialFromEnv();
const masterKey = loadOrCreateMasterKey(dataDir);
const suite = createCumulus({ labyrinth: labyrinthFromEnvironment(process.env, process.env.LBRNTH_SNAPSHOT_FILE ?? join(dataDir, "labyrinth.json")), ledger, signer, rpId: new URL(origin).hostname, origins: [origin], stores, social: { providers: social }, mailOrigin: origin, masterKey, upstreamIssuer: upstreamIssuerFromEnv(process.env) });
const backfilled = suite.provisionAll();

const app = createMailApp({
  suite,
  publicDir: join(import.meta.dirname, "..", "public"),
  origin,
  secureCookies: origin.startsWith("https://"),
  cookieDomain: cookieDomainForHost(new URL(origin).hostname, cumulus.cookieDomain),
  onChange: () => saveCumulusStores(dataDir, stores, { tunnel: suite.tunnel }),
});
if (backfilled) saveCumulusStores(dataDir, stores, { tunnel: suite.tunnel });

app.server().listen(port, () => {
  console.log(`Cumulus://Mail listening on ${origin} (ledger: ${verified.length} verified entries, mailboxes: ${stores.mail.mailboxes.size})`);
});
