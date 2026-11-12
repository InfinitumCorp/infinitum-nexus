/**
 * Cumulus://ID on PostgreSQL (relational-storage plan, phase 2).
 *
 * One row per account, identity link, authenticator, session, grant and organization, plus one table
 * for short-lived single-use items. Lookups that must be unique (username, credential id, session
 * token hash) are unique indexes, so two servers can't hand out the same one. The full entity is kept
 * in a `data` jsonb column next to the indexed keys, so adding a field to Account doesn't need a
 * migration. `seq` keeps lists in the order rows were first written, as the in-memory store does.
 *
 * Nothing here is switched on by default: CidService uses it only when it is given one
 * (`new CidService({ repository: new PgCidRepository({ db }) })`). The connection is passed in, so this
 * package doesn't depend on a driver: a `pg` Pool, or a Pool behind Cloudflare Hyperdrive, fits.
 */
import type { Account, Authenticator, CidOneTime, Grant, Organization, Session } from "./service.ts";
import type { CidRepository, OneTimeKind } from "./repository.ts";

/** The part of a `pg` Pool or Client this repository needs. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null; command?: string }>;
}

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

/** Tables and indexes. Idempotent; `schema` is created if it doesn't exist. */
export function cidSchemaSql(schema = "public"): string {
  if (!IDENT.test(schema)) throw new Error(`Bad schema name: ${schema}`);
  const t = (n: string) => `"${schema}".${n}`;
  return `
CREATE SCHEMA IF NOT EXISTS "${schema}";
CREATE TABLE IF NOT EXISTS ${t("cid_accounts")} (
  seq bigserial,
  cid text PRIMARY KEY,
  username text NOT NULL UNIQUE,
  org_id text,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS cid_accounts_org ON ${t("cid_accounts")} (org_id) WHERE org_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS ${t("cid_identities")} (key text PRIMARY KEY, cid text NOT NULL);
CREATE TABLE IF NOT EXISTS ${t("cid_federation")} (key text PRIMARY KEY, cid text NOT NULL);
CREATE TABLE IF NOT EXISTS ${t("cid_authenticators")} (
  seq bigserial,
  id text PRIMARY KEY,
  cid text NOT NULL,
  credential_id text NOT NULL UNIQUE,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS cid_authenticators_cid ON ${t("cid_authenticators")} (cid);
CREATE TABLE IF NOT EXISTS ${t("cid_sessions")} (
  seq bigserial,
  id text PRIMARY KEY,
  cid text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS cid_sessions_cid ON ${t("cid_sessions")} (cid);
CREATE TABLE IF NOT EXISTS ${t("cid_grants")} (
  seq bigserial,
  cid text NOT NULL,
  app text NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (cid, app)
);
CREATE TABLE IF NOT EXISTS ${t("cid_orgs")} (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS ${t("cid_pending")} (
  kind text NOT NULL,
  key text NOT NULL,
  expires_at bigint NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (kind, key)
);
CREATE INDEX IF NOT EXISTS cid_pending_expiry ON ${t("cid_pending")} (kind, expires_at);
`;
}

/** Create the tables, holding a transaction-scoped advisory lock so two servers starting at once don't race. */
export async function migrateCid(db: Queryable, schema = "public"): Promise<void> {
  // One simple-protocol query: every statement runs on the same connection, in one transaction.
  await db.query(`BEGIN; SELECT pg_advisory_xact_lock(hashtext('cumulus-id-migrate')); ${cidSchemaSql(schema)} COMMIT;`);
}

/** A pooled connection, as `pg` hands out from Pool.connect(). */
export interface PgPoolClient extends Queryable {
  release(err?: Error | boolean): void;
}

/**
 * One Postgres transaction per request, for hosts that save the rest of their state at the end of
 * the request and may re-run it (RemoteState in +SPCTR and Mail). Give it to PgCidRepository as its
 * `db`, and register it as a RemoteState participant: begin() opens a transaction on one pooled
 * connection, every query in the request runs on it (so the request sees its own writes), and
 * commit() / rollback() end it together with the ledger save. A re-run starts from a clean
 * transaction, so nothing a discarded attempt wrote survives.
 *
 * Requests on one instance must not overlap (RemoteState serializes them). Queries outside a
 * request (startup jobs) go straight to the pool.
 */
export class PgRequestScope implements Queryable {
  readonly #pool: Queryable & { connect(): Promise<PgPoolClient> };
  #client: PgPoolClient | null = null;

  constructor(pool: Queryable & { connect(): Promise<PgPoolClient> }) {
    this.#pool = pool;
  }

  get active(): boolean {
    return this.#client !== null;
  }

  async begin(): Promise<void> {
    if (this.#client) throw new Error("A request transaction is already open");
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
    } catch (err) {
      client.release(err as Error);
      throw err;
    }
    this.#client = client;
  }

  async commit(): Promise<void> {
    const client = this.#take();
    try {
      const r = await client.query("COMMIT");
      // After an error inside the transaction, Postgres answers COMMIT with ROLLBACK: nothing was saved.
      if (r.command === "ROLLBACK") throw new Error("The request's Postgres transaction was aborted by an earlier error; its writes were rolled back");
      client.release();
    } catch (err) {
      client.release(err as Error);
      throw err;
    }
  }

  async rollback(): Promise<void> {
    const client = this.#client;
    if (!client) return;
    this.#client = null;
    try {
      await client.query("ROLLBACK");
      client.release();
    } catch (err) {
      client.release(err as Error); // drop a broken connection instead of reusing it
    }
  }

  query(text: string, params?: unknown[]) {
    return (this.#client ?? this.#pool).query(text, params);
  }

  #take(): PgPoolClient {
    const client = this.#client;
    if (!client) throw new Error("No request transaction is open");
    this.#client = null;
    return client;
  }
}

export interface PgCidRepositoryOptions {
  db: Queryable;
  /** Postgres schema holding the tables. Default "public". */
  schema?: string;
  /** Run migrateCid before the first query. Default false: run migrations as a deploy step. */
  migrate?: boolean;
}

export class PgCidRepository implements CidRepository {
  readonly #db: Queryable;
  readonly #schema: string;
  #ready: Promise<void> | null;

  constructor(options: PgCidRepositoryOptions) {
    const schema = options.schema ?? "public";
    if (!IDENT.test(schema)) throw new Error(`Bad schema name: ${schema}`);
    this.#db = options.db;
    this.#schema = schema;
    this.#ready = options.migrate ? migrateCid(options.db, schema) : null;
  }

  async #q(sql: string, params: unknown[] = []) {
    if (this.#ready) await this.#ready;
    return this.#db.query(sql.replace(/\bT\.(\w+)/g, `"${this.#schema}".$1`), params);
  }
  async #one<T>(sql: string, params: unknown[]): Promise<T | undefined> {
    const { rows } = await this.#q(sql, params);
    return rows[0]?.data as T | undefined;
  }
  async #many<T>(sql: string, params: unknown[]): Promise<T[]> {
    const { rows } = await this.#q(sql, params);
    return rows.map((r) => r.data as T);
  }
  async #cid(sql: string, params: unknown[]): Promise<string | undefined> {
    const { rows } = await this.#q(sql, params);
    return rows[0]?.cid as string | undefined;
  }

  account(cid: string) {
    return this.#one<Account>("SELECT data FROM T.cid_accounts WHERE cid = $1", [cid]);
  }
  cidForUsername(username: string) {
    return this.#cid("SELECT cid FROM T.cid_accounts WHERE username = $1", [username]);
  }
  /** Insert or update. A username held by another account fails on the unique index. */
  async putAccount(account: Account) {
    await this.#q(
      `INSERT INTO T.cid_accounts (cid, username, org_id, data) VALUES ($1, $2, $3, $4)
       ON CONFLICT (cid) DO UPDATE SET username = EXCLUDED.username, org_id = EXCLUDED.org_id, data = EXCLUDED.data`,
      [account.cid, account.username, account.orgId ?? null, JSON.stringify(account)],
    );
  }
  allAccounts() {
    return this.#many<Account>("SELECT data FROM T.cid_accounts ORDER BY seq", []);
  }
  accountsInOrg(orgId: string) {
    return this.#many<Account>("SELECT data FROM T.cid_accounts WHERE org_id = $1 ORDER BY seq", [orgId]);
  }

  cidForIdentity(key: string) {
    return this.#cid("SELECT cid FROM T.cid_identities WHERE key = $1", [key]);
  }
  async setIdentity(key: string, cid: string) {
    await this.#q("INSERT INTO T.cid_identities (key, cid) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET cid = EXCLUDED.cid", [key, cid]);
  }
  async deleteIdentity(key: string) {
    await this.#q("DELETE FROM T.cid_identities WHERE key = $1", [key]);
  }
  cidForFederation(key: string) {
    return this.#cid("SELECT cid FROM T.cid_federation WHERE key = $1", [key]);
  }
  async setFederation(key: string, cid: string) {
    await this.#q("INSERT INTO T.cid_federation (key, cid) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET cid = EXCLUDED.cid", [key, cid]);
  }

  authenticator(id: string) {
    return this.#one<Authenticator>("SELECT data FROM T.cid_authenticators WHERE id = $1", [id]);
  }
  authenticatorByCredential(credentialId: string) {
    return this.#one<Authenticator>("SELECT data FROM T.cid_authenticators WHERE credential_id = $1", [credentialId]);
  }
  authenticatorsOf(cid: string) {
    return this.#many<Authenticator>("SELECT data FROM T.cid_authenticators WHERE cid = $1 ORDER BY seq", [cid]);
  }
  async putAuthenticator(auth: Authenticator) {
    await this.#q(
      `INSERT INTO T.cid_authenticators (id, cid, credential_id, data) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET cid = EXCLUDED.cid, credential_id = EXCLUDED.credential_id, data = EXCLUDED.data`,
      [auth.id, auth.cid, auth.credentialId, JSON.stringify(auth)],
    );
  }
  async deleteAuthenticator(auth: Authenticator) {
    await this.#q("DELETE FROM T.cid_authenticators WHERE id = $1", [auth.id]);
  }

  session(id: string) {
    return this.#one<Session>("SELECT data FROM T.cid_sessions WHERE id = $1", [id]);
  }
  sessionByTokenHash(tokenHash: string) {
    return this.#one<Session>("SELECT data FROM T.cid_sessions WHERE token_hash = $1", [tokenHash]);
  }
  sessionsOf(cid: string) {
    return this.#many<Session>("SELECT data FROM T.cid_sessions WHERE cid = $1 ORDER BY seq", [cid]);
  }
  async putSession(session: Session) {
    await this.#q(
      `INSERT INTO T.cid_sessions (id, cid, token_hash, data) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET cid = EXCLUDED.cid, token_hash = EXCLUDED.token_hash, data = EXCLUDED.data`,
      [session.id, session.cid, session.tokenHash, JSON.stringify(session)],
    );
  }

  grant(cid: string, app: string) {
    return this.#one<Grant>("SELECT data FROM T.cid_grants WHERE cid = $1 AND app = $2", [cid, app]);
  }
  grantsOf(cid: string) {
    return this.#many<Grant>("SELECT data FROM T.cid_grants WHERE cid = $1 ORDER BY seq", [cid]);
  }
  async putGrant(grant: Grant) {
    await this.#q(
      "INSERT INTO T.cid_grants (cid, app, data) VALUES ($1, $2, $3) ON CONFLICT (cid, app) DO UPDATE SET data = EXCLUDED.data",
      [grant.cid, grant.app, JSON.stringify(grant)],
    );
  }
  async deleteGrant(cid: string, app: string) {
    await this.#q("DELETE FROM T.cid_grants WHERE cid = $1 AND app = $2", [cid, app]);
  }

  org(id: string) {
    return this.#one<Organization>("SELECT data FROM T.cid_orgs WHERE id = $1", [id]);
  }
  async putOrg(org: Organization) {
    await this.#q("INSERT INTO T.cid_orgs (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data", [org.id, JSON.stringify(org)]);
  }

  async putOneTime<K extends OneTimeKind>(kind: K, key: string, value: CidOneTime[K]) {
    await this.#q(
      `INSERT INTO T.cid_pending (kind, key, expires_at, data) VALUES ($1, $2, $3, $4)
       ON CONFLICT (kind, key) DO UPDATE SET expires_at = EXCLUDED.expires_at, data = EXCLUDED.data`,
      [kind, key, Math.floor((value as { expiresAt: number }).expiresAt), JSON.stringify(value)],
    );
  }
  peekOneTime<K extends OneTimeKind>(kind: K, key: string) {
    return this.#one<CidOneTime[K]>("SELECT data FROM T.cid_pending WHERE kind = $1 AND key = $2", [kind, key]);
  }
  /** DELETE … RETURNING: of two concurrent takes, exactly one gets the item. */
  takeOneTime<K extends OneTimeKind>(kind: K, key: string) {
    return this.#one<CidOneTime[K]>("DELETE FROM T.cid_pending WHERE kind = $1 AND key = $2 RETURNING data", [kind, key]);
  }
  async deleteOneTime(kind: OneTimeKind, key: string) {
    await this.#q("DELETE FROM T.cid_pending WHERE kind = $1 AND key = $2", [kind, key]);
  }
  async sweepOneTime(kind: OneTimeKind, now: number) {
    await this.#q("DELETE FROM T.cid_pending WHERE kind = $1 AND expires_at < $2", [kind, Math.floor(now)]);
  }
}
