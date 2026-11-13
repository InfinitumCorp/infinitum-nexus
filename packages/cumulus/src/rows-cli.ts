/**
 * Copy Mail, FIRM Wallet and the storage quota from their documents into Postgres rows, before a host
 * sets CUMULUS_ROWS (relational storage plan, phase 5).
 *
 *   node --experimental-strip-types packages/cumulus/src/rows-cli.ts [--write] [--schema cumulus_id]
 *        [--products mail,wallet,quota] (--from-nexus-docs | --dir DATA_DIR)
 *
 * Source, one of:
 *   --from-nexus-docs    the "cumulus-mail", "firm-wallet" and "cumulus-quota" rows of nexus_docs at
 *                        NEXUS_DATABASE_URL (hosted products)
 *   --dir DATA_DIR       mail.json, wallet.json and quota.json written by a single server (mailboxes
 *                        there are sealed at rest: CUMULUS_MAIL_MASTER_KEY, or DATA_DIR/tunnel-master.key;
 *                        a missing key is an error, never made)
 * Target: CID_DATABASE_URL, the database CUMULUS_STORE=postgres already uses.
 *
 * Without --write it is a dry run that prints counts. With --write it creates the tables, upserts
 * everything (safe to repeat), reads it all back and exits non-zero if anything differs. Mail is
 * sealed in the tables when a master key is given (CUMULUS_MAIL_MASTER_KEY), with the tunnel keys
 * from DATA_DIR/tunnel.json when there is one. The documents are left as they are.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { QuotaStore } from "@infinitum/cloud";
import { WalletStore } from "@infinitum/firm";
import { CumulusTunnel, PostOfficeStore, TunnelStore, openMailStore, parseMasterKey } from "@infinitum/mail";
import { applySnapshot, loadSnapshot } from "./persist.ts";
import { backfillProductRows, parseRowProducts, type RowsSource } from "./rows.ts";

const { values } = parseArgs({
  options: {
    "from-nexus-docs": { type: "boolean", default: false },
    dir: { type: "string" },
    write: { type: "boolean", default: false },
    schema: { type: "string", default: "public" },
    products: { type: "string", default: "mail,wallet,quota" },
  },
});

const products = parseRowProducts(values.products);
const { default: pg } = await import("pg");
const source: RowsSource = {};
const docs = { mail: "cumulus-mail", wallet: "firm-wallet", quota: "cumulus-quota" } as const;
const files = { mail: "mail.json", wallet: "wallet.json", quota: "quota.json" } as const;
const fresh = { mail: () => new PostOfficeStore(), wallet: () => new WalletStore(), quota: () => new QuotaStore() } as const;
let tunnel: CumulusTunnel | undefined;

if (values["from-nexus-docs"]) {
  const url = process.env.NEXUS_DATABASE_URL;
  if (!url) throw new Error("--from-nexus-docs needs NEXUS_DATABASE_URL");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    for (const p of products) {
      const { rows } = await client.query("SELECT data FROM nexus_docs WHERE id = $1", [docs[p]]);
      if (!rows.length) {
        console.log(`nexus_docs has no "${docs[p]}" row: nothing to copy for ${p}`);
        continue;
      }
      const data = typeof rows[0].data === "string" ? JSON.parse(rows[0].data) : rows[0].data;
      (source as Record<string, unknown>)[p] = applySnapshot(fresh[p](), data);
    }
  } finally {
    await client.end();
  }
  if (process.env.CUMULUS_MAIL_MASTER_KEY) tunnel = new CumulusTunnel({ masterKey: parseMasterKey(process.env.CUMULUS_MAIL_MASTER_KEY) });
} else if (values.dir) {
  for (const p of products) {
    const path = join(values.dir, files[p]);
    if (existsSync(path)) (source as Record<string, unknown>)[p] = loadSnapshot(path, fresh[p]());
  }
  const tunnelStore = new TunnelStore();
  if (existsSync(join(values.dir, "tunnel.json"))) loadSnapshot(join(values.dir, "tunnel.json"), tunnelStore);
  // Only an existing key: a copy must never make a new one.
  const keyFile = join(values.dir, "tunnel-master.key");
  const key = process.env.CUMULUS_MAIL_MASTER_KEY ?? (existsSync(keyFile) ? readFileSync(keyFile, "utf8") : undefined);
  if (!key) throw new Error(`No master key: set CUMULUS_MAIL_MASTER_KEY or put it in ${keyFile}`);
  tunnel = new CumulusTunnel({ store: tunnelStore, masterKey: parseMasterKey(key) });
  if (source.mail) {
    const locked = openMailStore(source.mail, tunnel);
    if (locked) throw new Error(`${locked} message(s) couldn't be opened with this master key; not copying`);
  }
} else {
  throw new Error("Give a source: --from-nexus-docs or --dir DATA_DIR");
}

const counts = {
  mailboxes: source.mail?.mailboxes.size ?? 0,
  messages: [...(source.mail?.mailboxes.values() ?? [])].reduce((n, b) => n + b.messages.length, 0),
  wallets: source.wallet?.accounts.size ?? 0,
  transfers: source.wallet?.transfers.size ?? 0,
  quotas: source.quota?.usage.size ?? 0,
};
console.log(JSON.stringify({ step: "check", products, counts, sealed: Boolean(tunnel?.persistent) }));
if (!values.write) {
  console.log("Dry run: nothing written. Add --write to copy into CID_DATABASE_URL.");
  process.exit(0);
}

const url = process.env.CID_DATABASE_URL;
if (!url) throw new Error("--write needs CID_DATABASE_URL");
const pool = new pg.Pool({ connectionString: url, max: 4 });
try {
  const report = await backfillProductRows(source, pool, { schema: values.schema, tunnel, onProgress: (l) => console.log(l) });
  console.log(JSON.stringify({ step: "verify", counts: report.counts, mismatches: report.mismatches.length }));
  for (const m of report.mismatches.slice(0, 50)) console.log(`mismatch: ${m}`);
  process.exitCode = report.mismatches.length ? 3 : 0;
} finally {
  await pool.end();
}
