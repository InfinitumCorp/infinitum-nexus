/**
 * Local development only: creates two test accounts (devalex, devleah) in MAIL_DATA_DIR with a
 * virtual passkey, sends a few messages and a test payment, and prints a session cookie for devalex
 * so the signed-in app can be checked without a hardware authenticator.
 *
 *   node --experimental-strip-types apps/cumulus-mail/scripts/dev-seed.ts
 *
 * Refuses to run against an https origin. Never use it on a real deployment.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Ledger, FileStore, generateSigner, signerFromPrivateKey } from "@infinitum/firmament";
import { createCumulus, emptyCumulusStores, loadCumulusStores, loadOrCreateMasterKey, saveCumulusStores } from "@infinitum/cumulus";
import { VirtualAuthenticator } from "../../../packages/cid/src/testing/virtual-authenticator.ts";

const port = Number(process.env.PORT ?? 3010);
const origin = (process.env.MAIL_ORIGIN ?? `http://localhost:${port}`).replace(/\/$/, "");
if (origin.startsWith("https://")) throw new Error("dev-seed is for local development only");
const dataDir = process.env.MAIL_DATA_DIR ?? join(import.meta.dirname, "..", "data");
mkdirSync(dataDir, { recursive: true });

const keyFile = join(dataDir, "firmament-signer.key");
const signer = existsSync(keyFile) ? signerFromPrivateKey(readFileSync(keyFile, "utf8").trim()) : generateSigner();
if (!existsSync(keyFile)) writeFileSync(keyFile, signer.exportPrivateKey());
const ledger = new Ledger(new FileStore(join(dataDir, "firmament.jsonl")), { authorizedSigners: [signer.publicKey] });
const stores = loadCumulusStores(dataDir, emptyCumulusStores());
const rpId = new URL(origin).hostname;
const suite = createCumulus({ ledger, signer, rpId, origins: [origin], stores, mailOrigin: origin, masterKey: loadOrCreateMasterKey(dataDir) });

async function account(username: string) {
  const existing = await suite.cid.cidForUsername(username);
  if (existing) return existing;
  const auth = new VirtualAuthenticator();
  const a = await suite.cid.createAccount({ username });
  const opts = await suite.cid.startAuthenticatorRegistration(a.cid, "passkey");
  await suite.cid.finishAuthenticatorRegistration(a.cid, auth.create({ challenge: opts.challenge, origin, rpId }), { kind: "passkey", label: "Dev passkey" });
  await suite.cid.grant(a.cid, "cumulus-mail", ["mail:read", "mail:write"]);
  return a.cid;
}

const alex = await account("devalex");
const leah = await account("devleah");
if ((await suite.wallets.balances(alex)).USDC === "0") {
  await suite.credit(alex, "USDC", "250", "Test settlement (dev seed)");
  await suite.mail.send(leah, { to: "devalex@cumuluscloud.app", subject: "ODIN briefing notes", body: "Alex,\n\nThe notes are in Cumulus://Cloud, shared only with you.\n\nLeah" });
  await suite.mail.send(alex, { to: "devleah@cumuluscloud.app", subject: "Dinner — my half", body: "Thanks for organizing.", payment: { asset: "USDC", amount: "38.40" } });
  suite.cloud.put("odin-briefing.pdf", leah, 2_400_000);
  await suite.shareFile(leah, "odin-briefing.pdf", "devalex@cumuluscloud.app");
}
const { token } = await suite.cid["issueSession"](alex, "dev-seed", "passkey");
saveCumulusStores(dataDir, stores, { tunnel: suite.tunnel });
console.log(`Seeded ${dataDir}\nSession cookie for devalex (local only):\ncmail_session=${token}`);
