/**
 * Where hosted products keep Cumulus://ID (relational storage plan, phase 4).
 *
 *   CUMULUS_STORE unset or "document"  today's path: the `cid` document in nexus_docs, loaded whole
 *                                      into memory and saved with every request.
 *   CUMULUS_STORE=postgres             one row per account, session, key and grant in Postgres
 *                                      (PgCidRepository). Each request's ID reads and writes run
 *                                      in one Postgres transaction that commits only after the
 *                                      ledger and the other documents were saved, and rolls back
 *                                      whenever RemoteState re-runs or abandons the request.
 *
 * The database is CID_DATABASE_URL, or a Cloudflare Hyperdrive binding passed to
 * useCidDatabaseUrl() by the Worker. CID_DATABASE_SCHEMA picks the schema (default "public").
 * Create the tables and copy the document first with the backfill (packages/cid backfill-cli.ts);
 * the `cid` document stays untouched in nexus_docs, so setting CUMULUS_STORE back to "document"
 * is the rollback.
 */
import { PgCidRepository, PgRequestScope, type CidRepository, type PgPoolClient, type Queryable } from "@infinitum/cid";
import type { TransactionParticipant } from "./remote.ts";

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
  /** Commits and rolls back with each request (Postgres mode). */
  participant?: TransactionParticipant;
}

export function cidStorageFromEnv(env: Record<string, string | undefined> = process.env): CidStorage {
  const mode = (env.CUMULUS_STORE ?? "document").trim().toLowerCase();
  if (mode === "document" || mode === "") return { inDocuments: true };
  if (mode !== "postgres") throw new Error(`CUMULUS_STORE must be "document" or "postgres", not "${env.CUMULUS_STORE}"`);
  const url = databaseUrlOverride ?? env.CID_DATABASE_URL;
  if (!url) throw new Error("CUMULUS_STORE=postgres needs CID_DATABASE_URL (or a Hyperdrive binding)");
  const scope = new PgRequestScope(lazyPool(url));
  return {
    inDocuments: false,
    repository: new PgCidRepository({ db: scope, schema: env.CID_DATABASE_SCHEMA || "public" }),
    participant: scope,
  };
}

/** A `pg` Pool loaded on first use, so document-mode deployments never load the driver. */
function lazyPool(connectionString: string): Queryable & { connect(): Promise<PgPoolClient> } {
  let pool: Promise<Queryable & { connect(): Promise<PgPoolClient> }> | undefined;
  const get = () =>
    (pool ??= import("pg").then(({ default: pg }) => new pg.Pool({ connectionString, max: 5 }) as unknown as Queryable & { connect(): Promise<PgPoolClient> }));
  return {
    query: async (text, params) => (await get()).query(text, params),
    connect: async () => (await get()).connect(),
  };
}
