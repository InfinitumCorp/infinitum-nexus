/**
 * Cumulus://ID storage for a single server (main.ts: the Russia issuer at ru-id.cumuluscloud.app,
 * local runs). Hosted products use cid-store.ts instead.
 *
 *   CUMULUS_STORE unset or "document"  cid.json in the data directory, as before.
 *   CUMULUS_STORE=postgres             rows in Postgres at CID_DATABASE_URL (schema CID_DATABASE_SCHEMA,
 *                                      default "public"). On the Russia server that is Postgres on the
 *                                      same Yandex machine, reached over its Unix socket with the
 *                                      service's own OS user (peer authentication), so there is no
 *                                      password anywhere: postgresql:///cumulus_id?host=/var/run/postgresql
 *
 * In Postgres mode the tables are created on start, and the first start with empty tables copies
 * cid.json into them and checks every row (backfillCid); it refuses to start if anything differs.
 * cid.json is then left as it was (no longer written), so CUMULUS_STORE=document is the rollback.
 * One process per database. Each request runs in its own Postgres transaction on its own connection
 * (`transaction`, given to createApp), so a request's ID, mail, payment and storage changes are saved
 * together or not at all, and requests still run side by side (a slow AI answer holds up no one): row
 * locks order the ones that touch the same mailbox, wallet or quota. Two that lock the same rows in
 * opposite order (two people mailing each other at the same instant) are ended by Postgres's deadlock
 * check: one of them is rolled back whole and answered with an error, nothing half-saved. Work outside
 * a request (start-up) commits each write on its own.
 *
 * CUMULUS_ROWS=mail,wallet,quota (Postgres mode only) keeps those as rows in the same database too.
 * The first start with empty tables copies mail.json, wallet.json and quota.json in (mail opened with
 * the tunnel master key, and sealed again in the table) and checks every row; it refuses to start if
 * anything differs. The files are then left as they were (no longer written): removing a product from
 * CUMULUS_ROWS is the rollback.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { PgCidRepository, backfillCid, migrateCid, type CidRepository, type CidStore, type PgPoolClient, type Queryable } from "@infinitum/cid";
import { backfillProductRows, migrateProductRows, parseRowProducts, productRepositories, type CumulusConfig, type CumulusStores, type RowProduct } from "@infinitum/cumulus";
import { CumulusTunnel, openMailStore } from "@infinitum/mail";

export interface LocalCidStorage {
  /** For createCumulus; undefined in document mode. */
  repository?: CidRepository;
  /** Stores not to write back to the data directory (cid in Postgres mode, and the CUMULUS_ROWS products). */
  skipFiles: string[];
  /** Mail, Wallet and Quota repositories for createCumulus (CUMULUS_ROWS). */
  repositories?: CumulusConfig["repositories"];
  /** For createApp: runs each request in its own Postgres transaction. */
  transaction?: <T>(fn: () => Promise<T>) => Promise<T>;
  describe: string;
  close(): Promise<void>;
}

export async function localCidStorage(
  fileStore: CidStore,
  env: Record<string, string | undefined> = process.env,
  log: (line: string) => void = console.log,
  /** The other stores, as loaded from the data directory, and the tunnel master key (for CUMULUS_ROWS). */
  files?: { stores: CumulusStores; masterKey?: Buffer },
): Promise<LocalCidStorage> {
  const mode = (env.CUMULUS_STORE ?? "document").trim().toLowerCase();
  const products = parseRowProducts(env.CUMULUS_ROWS);
  if (products.length && mode !== "postgres") throw new Error("CUMULUS_ROWS needs CUMULUS_STORE=postgres");
  if (products.length && !files) throw new Error("CUMULUS_ROWS needs the data directory's stores");
  if (mode === "document" || mode === "") return { skipFiles: [], describe: "cid.json", close: async () => {} };
  if (mode !== "postgres") throw new Error(`CUMULUS_STORE must be "document" or "postgres" on a single server, not "${env.CUMULUS_STORE}"`);
  const url = env.CID_DATABASE_URL;
  if (!url) throw new Error("CUMULUS_STORE=postgres needs CID_DATABASE_URL (e.g. postgresql:///cumulus_id?host=/var/run/postgresql)");
  const schema = env.CID_DATABASE_SCHEMA || "public";
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: url, max: 20 });
  pool.on("error", (err: Error) => console.error(`cumulus: idle database connection closed: ${err.message}`));
  try {
    await migrateCid(pool, schema);
    const scope = new ConcurrentScope(pool as unknown as Queryable & { connect(): Promise<PgPoolClient> });
    const repository = new PgCidRepository({ db: scope, schema });
    const existing = await repository.allAccounts();
    if (!existing.length && fileStore.accounts.size) {
      const report = await backfillCid(fileStore, repository);
      if (report.mismatches.length || report.sourceHash !== report.targetHash) {
        throw new Error(`cid.json -> Postgres copy differs (${report.mismatches.length} mismatches, first: ${report.mismatches[0] ?? "hash"}); not starting`);
      }
      log(`Cumulus://ID: copied cid.json into Postgres (${report.counts.accounts} accounts, ${report.counts.authenticators} keys, ${report.counts.sessions} sessions, ${report.counts.grants} grants), every row verified`);
    }
    // The in-memory store is no longer the source of truth; drop it so nothing reads stale data.
    for (const v of Object.values(fileStore)) if (v instanceof Map) v.clear();
    const skipFiles = ["cid"];
    let repositories: CumulusConfig["repositories"];
    if (products.length) {
      await migrateProductRows(pool, products, schema);
      await copyProductsOnce(pool, schema, products, files!, log);
      repositories = productRepositories(products, scope, schema);
      skipFiles.push(...products);
    }
    const transaction = <T>(fn: () => Promise<T>): Promise<T> => scope.run(fn);
    const what = products.length ? `Postgres (schema ${schema}; also ${products.join(", ")})` : `Postgres (schema ${schema})`;
    return { repository, repositories, skipFiles, transaction, describe: what, close: () => pool.end() };
  } catch (err) {
    await pool.end().catch(() => undefined);
    throw err;
  }
}

/** First start with CUMULUS_ROWS: copy the products' files into empty tables, verified; later starts do nothing. */
async function copyProductsOnce(db: Queryable, schema: string, products: RowProduct[], files: { stores: CumulusStores; masterKey?: Buffer }, log: (line: string) => void) {
  const empty = async (table: string) => !(await db.query(`SELECT 1 FROM "${schema}".${table} LIMIT 1`)).rows.length;
  const source: Parameters<typeof backfillProductRows>[0] = {};
  if (products.includes("mail") && (await empty("mail_mailboxes")) && files.stores.mail.mailboxes.size) source.mail = files.stores.mail;
  if (products.includes("wallet") && (await empty("wallet_accounts")) && files.stores.wallet.accounts.size) source.wallet = files.stores.wallet;
  if (products.includes("quota") && (await empty("quota_usage")) && files.stores.quota.usage.size) source.quota = files.stores.quota;
  if (!source.mail && !source.wallet && !source.quota) return;
  const tunnel = files.masterKey ? new CumulusTunnel({ store: files.stores.tunnel, masterKey: files.masterKey }) : undefined;
  if (source.mail && tunnel) {
    const locked = openMailStore(source.mail, tunnel);
    if (locked) throw new Error(`${locked} message(s) in mail.json couldn't be opened with this master key; not copying`);
  }
  const report = await backfillProductRows(source, db, { schema, tunnel });
  if (report.mismatches.length) throw new Error(`files -> Postgres copy differs (${report.mismatches.length}, first: ${report.mismatches[0]}); not starting`);
  log(`Cumulus: copied ${Object.keys(source).join(", ")} into Postgres (${Object.entries(report.counts).map(([k, v]) => `${v} ${k}`).join(", ")}), every row verified`);
}

/**
 * Queries go to the current request's connection (inside its transaction) when there is one, else to
 * the pool. Each request gets its own connection, so requests don't wait for each other.
 */
export class ConcurrentScope implements Queryable {
  readonly #pool: Queryable & { connect(): Promise<PgPoolClient> };
  readonly #current = new AsyncLocalStorage<PgPoolClient>();

  constructor(pool: Queryable & { connect(): Promise<PgPoolClient> }) {
    this.#pool = pool;
  }

  query(text: string, params?: unknown[]) {
    return (this.#current.getStore() ?? this.#pool).query(text, params);
  }

  /** Run `fn` in a transaction of its own: committed if it returns, rolled back if it throws. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#current.getStore()) return fn(); // already inside one
    const client = await this.#pool.connect();
    let broken: Error | undefined;
    try {
      await client.query("BEGIN");
      const result = await this.#current.run(client, fn);
      const r = await client.query("COMMIT");
      // After an error inside the transaction, Postgres answers COMMIT with ROLLBACK: nothing was saved.
      if (r.command === "ROLLBACK") throw new Error("The request's Postgres transaction was aborted by an earlier error; its writes were rolled back");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (e) {
        broken = e as Error; // drop a broken connection instead of reusing it
      }
      throw err;
    } finally {
      client.release(broken);
    }
  }
}
