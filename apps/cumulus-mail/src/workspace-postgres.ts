/**
 * Cumulus://Drive metadata on PostgreSQL (CUMULUS_ROWS=drive with CUMULUS_STORE=postgres): one row per
 * item in drive_items (owner, folder and who it is shared with as columns, the item as JSON) and one
 * per person who opened Drive in drive_enabled.
 *
 * Reading an item takes its row lock (SELECT … FOR UPDATE), so inside a request's transaction two saves
 * of the same document are applied one after the other and the version check ("someone changed this
 * since you opened it") sees the first one: neither is lost. Listings read without locks.
 */
import type { DriveItem, WorkspaceRepository, WorkspaceStore } from "./workspace.ts";

export interface DriveQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

export function driveSchemaSql(schema = "public"): string {
  if (!IDENT.test(schema)) throw new Error(`Bad schema name: ${schema}`);
  const s = `"${schema}"`;
  return `
CREATE SCHEMA IF NOT EXISTS ${s};
CREATE TABLE IF NOT EXISTS ${s}.drive_items (
  id text PRIMARY KEY,
  owner text NOT NULL,
  parent text,
  shared_with text[] NOT NULL DEFAULT '{}',
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS drive_items_owner ON ${s}.drive_items (owner);
CREATE INDEX IF NOT EXISTS drive_items_parent ON ${s}.drive_items (parent) WHERE parent IS NOT NULL;
CREATE INDEX IF NOT EXISTS drive_items_shared ON ${s}.drive_items USING gin (shared_with);
CREATE TABLE IF NOT EXISTS ${s}.drive_enabled (
  cid text PRIMARY KEY,
  at text NOT NULL
);
CREATE TABLE IF NOT EXISTS ${s}.drive_claims (
  id int PRIMARY KEY CHECK (id = 1),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  copied jsonb NOT NULL
);
`;
}

/** A connection that can hold a transaction (a pg Pool, or a request scope with begin/commit/rollback). */
export interface DriveTransactional extends DriveQueryable {
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/**
 * The first start with CUMULUS_ROWS=drive: copy what the cumulus-workspace document holds (`load` is
 * called only then) into the tables, once ever, in one transaction under a lock, and record it. Later
 * starts, and other servers, do nothing, so rows written since are never replaced.
 */
export async function claimDriveRows(
  db: DriveTransactional,
  schema: string,
  load: () => Promise<WorkspaceStore>,
): Promise<{ copied: { items: number; enabled: number } } | { already: true }> {
  await migrateDrive(db, schema);
  const s = `"${schema}"`;
  await db.begin();
  try {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('cumulus-drive-claim|' || $1))`, [schema]);
    if ((await db.query(`SELECT 1 FROM ${s}.drive_claims WHERE id = 1`)).rows.length) {
      await db.commit();
      return { already: true };
    }
    const store = await load();
    const repo = new PgWorkspaceRepository({ db, schema });
    for (const item of store.items.values()) await repo.putItem(item);
    for (const [cid, at] of store.enabled) await repo.setEnabled(cid, at);
    const copied = { items: store.items.size, enabled: store.enabled.size };
    await db.query(`INSERT INTO ${s}.drive_claims (id, copied) VALUES (1, $1)`, [JSON.stringify(copied)]);
    await db.commit();
    return { copied };
  } catch (err) {
    await db.rollback();
    throw err;
  }
}

export async function migrateDrive(db: DriveQueryable, schema = "public"): Promise<void> {
  // One message without BEGIN/COMMIT is one implicit transaction: on an error it is rolled back, so the
  // pooled connection isn't left in an aborted transaction.
  const sql = `SELECT pg_advisory_xact_lock(hashtext('cumulus-drive-migrate')); ${driveSchemaSql(schema)}`;
  try {
    await db.query(sql);
  } catch (err) {
    // Two servers starting at once: the advisory lock doesn't refresh the catalog the statements in the
    // same message see, so the second can still try to create what the first just did. Once more is enough.
    if (!isAlreadyCreated(err)) throw err;
    await db.query(sql);
  }
}

/** unique_violation on a catalog, duplicate_schema, duplicate_table, duplicate_object. */
const isAlreadyCreated = (err: unknown) => ["23505", "42P06", "42P07", "42710"].includes((err as { code?: string } | null)?.code ?? "");

export class PgWorkspaceRepository implements WorkspaceRepository {
  readonly #db: DriveQueryable;
  readonly #s: string;

  constructor(options: { db: DriveQueryable; schema?: string }) {
    const schema = options.schema ?? "public";
    if (!IDENT.test(schema)) throw new Error(`Bad schema name: ${schema}`);
    this.#db = options.db;
    this.#s = `"${schema}"`;
  }

  async item(id: string): Promise<DriveItem | undefined> {
    const { rows } = await this.#db.query(`SELECT data FROM ${this.#s}.drive_items WHERE id = $1 FOR UPDATE`, [id]);
    return rows[0]?.data;
  }

  async putItem(item: DriveItem): Promise<void> {
    await this.#db.query(
      `INSERT INTO ${this.#s}.drive_items (id, owner, parent, shared_with, data) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET owner = EXCLUDED.owner, parent = EXCLUDED.parent, shared_with = EXCLUDED.shared_with, data = EXCLUDED.data`,
      [item.id, item.owner, item.parent, item.sharedWith, JSON.stringify(item)],
    );
  }

  async deleteItem(id: string): Promise<void> {
    await this.#db.query(`DELETE FROM ${this.#s}.drive_items WHERE id = $1`, [id]);
  }

  async itemsOf(owner: string): Promise<DriveItem[]> {
    const { rows } = await this.#db.query(`SELECT data FROM ${this.#s}.drive_items WHERE owner = $1`, [owner]);
    return rows.map((r) => r.data);
  }

  async children(parent: string): Promise<DriveItem[]> {
    const { rows } = await this.#db.query(`SELECT data FROM ${this.#s}.drive_items WHERE parent = $1`, [parent]);
    return rows.map((r) => r.data);
  }

  async sharedWith(cid: string): Promise<DriveItem[]> {
    const { rows } = await this.#db.query(`SELECT data FROM ${this.#s}.drive_items WHERE shared_with @> ARRAY[$1]::text[]`, [cid]);
    return rows.map((r) => r.data);
  }

  async enabledAt(cid: string): Promise<string | undefined> {
    const { rows } = await this.#db.query(`SELECT at FROM ${this.#s}.drive_enabled WHERE cid = $1`, [cid]);
    return rows[0]?.at;
  }

  async setEnabled(cid: string, at: string): Promise<void> {
    await this.#db.query(`INSERT INTO ${this.#s}.drive_enabled (cid, at) VALUES ($1, $2) ON CONFLICT (cid) DO NOTHING`, [cid, at]);
  }
}
