/**
 * Where hosted products keep Cumulus://ID (relational storage plan, phase 4).
 *
 *   CUMULUS_STORE unset or "document"  today's path: the `cid` document in nexus_docs, loaded whole
 *                                      into memory and saved with every request.
 *   CUMULUS_STORE=gateway              the same rows in Supabase, reached through the nexus-store
 *                                      edge function the host already uses (no database password):
 *                                      reads go through it, and the request's writes are saved by the
 *                                      same database transaction as the ledger (nexus_commit_cid).
 *   CUMULUS_STORE=postgres             one row per account, session, key and grant in Postgres
 *                                      (PgCidRepository). Each request's ID reads and writes run
 *                                      in one Postgres transaction that commits only after the
 *                                      ledger and the other documents were saved, and rolls back
 *                                      whenever RemoteState re-runs or abandons the request.
 *
 * CUMULUS_ROWS (with CUMULUS_STORE=postgres only) moves more products into the same database and the
 * same per-request transaction: a comma-separated list of "mail", "wallet", "quota". Their documents
 * ("cumulus-mail", "firm-wallet", "cumulus-quota") are then no longer loaded or saved. Copy them in
 * first with packages/cumulus/src/rows-cli.ts; the documents stay as they were, so removing a product
 * from CUMULUS_ROWS is the rollback (anything written to its rows since is not carried back).
 *
 * The database is CID_DATABASE_URL, or a Cloudflare Hyperdrive binding passed to
 * useCidDatabaseUrl() by the Worker. CID_DATABASE_SCHEMA picks the schema (default "public").
 * Create the tables and copy the document first with the backfill (packages/cid backfill-cli.ts);
 * the `cid` document stays untouched in nexus_docs, so setting CUMULUS_STORE back to "document"
 * is the rollback.
 */
import { PgCidRepository, PgRequestScope, RemoteCidRepository, type CidReadOp, type CidRepository, type PgPoolClient, type Queryable } from "@infinitum/cid";
import { parseRowProducts, productRepositories, type CumulusConfig, type RowProduct } from "@infinitum/cumulus";
import type { NexusGateway, TransactionParticipant } from "./remote.ts";

let databaseUrlOverride: string | undefined;
/** The Worker passes its Hyperdrive connection string here before the first request. */
export function useCidDatabaseUrl(url: string) {
  databaseUrlOverride = url;
}

export interface CidStorage {
  /** Keep the `cid` document in RemoteState (document mode). */
  inDocuments: boolean;
  /** The repository for CidService (Postgres mode). */
  repository?: CidRepository;
  /** Commits and rolls back with each request (Postgres and gateway modes). */
  participant?: TransactionParticipant;
  /** Row writes the gateway saves with the ledger (gateway mode): set as RemoteState.rows. */
  rows?: { pending(): unknown[] };
  /** Products kept as rows in the same database (CUMULUS_ROWS); their documents aren't loaded. */
  products: RowProduct[];
  /** Their repositories, for createCumulus({ repositories }). */
  repositories?: CumulusConfig["repositories"];
}

/** The RemoteState document each row product replaces. */
export const PRODUCT_DOCUMENTS: Record<RowProduct, string> = { mail: "cumulus-mail", wallet: "firm-wallet", quota: "cumulus-quota" };

/**
 * The suite's documents a host keeps in RemoteState: `cid` unless ID is in rows, and Mail, Wallet and
 * Quota unless CUMULUS_ROWS keeps them as rows.
 */
export function suiteDocuments(storage: CidStorage, stores: { cid: object; mail: object; wallet: object; quota: object; suite: object }): Record<string, object> {
  const docs: Record<string, object> = {
    ...(storage.inDocuments ? { cid: stores.cid } : {}),
    [PRODUCT_DOCUMENTS.mail]: stores.mail,
    [PRODUCT_DOCUMENTS.wallet]: stores.wallet,
    [PRODUCT_DOCUMENTS.quota]: stores.quota,
    "cumulus-suite": stores.suite,
  };
  for (const product of storage.products) delete docs[PRODUCT_DOCUMENTS[product]];
  return docs;
}

export function cidStorageFromEnv(env: Record<string, string | undefined> = process.env, gateway?: NexusGateway): CidStorage {
  const mode = (env.CUMULUS_STORE ?? "document").trim().toLowerCase();
  const products = parseRowProducts(env.CUMULUS_ROWS);
  if (products.length && mode !== "postgres") throw new Error("CUMULUS_ROWS needs CUMULUS_STORE=postgres");
  if (mode === "document" || mode === "") return { inDocuments: true, products };
  if (mode === "gateway") {
    const read = gateway?.readRows?.bind(gateway);
    if (!read) throw new Error("CUMULUS_STORE=gateway needs the nexus-store gateway (NEXUS_STORE_URL); this host's store doesn't keep ID rows");
    const repo = new RemoteCidRepository((ops: CidReadOp[]) => read(ops));
    return {
      inDocuments: false,
      products,
      repository: repo,
      rows: repo,
      // A new request, and every re-run, starts from the rows as saved.
      participant: { begin: async () => repo.begin(), commit: async () => repo.begin(), rollback: async () => repo.begin() },
    };
  }
  if (mode !== "postgres") throw new Error(`CUMULUS_STORE must be "document", "gateway" or "postgres", not "${env.CUMULUS_STORE}"`);
  const url = databaseUrlOverride ?? env.CID_DATABASE_URL;
  if (!url) throw new Error("CUMULUS_STORE=postgres needs CID_DATABASE_URL (or a Hyperdrive binding)");
  const scope = new PgRequestScope(lazyPool(url));
  const schema = env.CID_DATABASE_SCHEMA || "public";
  return {
    inDocuments: false,
    products,
    repository: new PgCidRepository({ db: scope, schema }),
    repositories: products.length ? productRepositories(products, scope, schema) : undefined,
    participant: scope,
  };
}

/** A `pg` Pool loaded on first use, so document-mode deployments never load the driver. */
function lazyPool(connectionString: string): Queryable & { connect(): Promise<PgPoolClient> } {
  let pool: Promise<Queryable & { connect(): Promise<PgPoolClient> }> | undefined;
  const get = () =>
    (pool ??= import("pg").then(({ default: pg }) => {
      const p = new pg.Pool({ connectionString, max: 5 });
      // An idle connection the server closes (restart, failover) is dropped from the pool, not a crash.
      p.on("error", (err: Error) => console.error(`cumulus: idle database connection closed: ${err.message}`));
      return p as unknown as Queryable & { connect(): Promise<PgPoolClient> };
    }));
  return {
    query: async (text, params) => (await get()).query(text, params),
    connect: async () => (await get()).connect(),
  };
}
