/**
 * Storage quota on PostgreSQL (relational storage plan, phase 5): one row per person in quota_usage.
 *
 * Usage reads take a lock on the person (an advisory lock, which also covers someone with no row yet,
 * and a row lock), so inside a request's transaction two uploads by the same person are charged one
 * after the other, and both can't squeeze into the last free bytes.
 * The connection is passed in (a `pg` Pool, Hyperdrive or a request scope); off unless StorageQuota is
 * given one.
 */
import type { QuotaProduct, QuotaRepository } from "./quota.ts";

export interface QuotaQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

export function quotaSchemaSql(schema = "public"): string {
  if (!IDENT.test(schema)) throw new Error(`Bad schema name: ${schema}`);
  return `
CREATE SCHEMA IF NOT EXISTS "${schema}";
CREATE TABLE IF NOT EXISTS "${schema}".quota_usage (
  cid text PRIMARY KEY,
  mail_bytes bigint NOT NULL DEFAULT 0 CHECK (mail_bytes >= 0),
  cloud_bytes bigint NOT NULL DEFAULT 0 CHECK (cloud_bytes >= 0),
  extra_gb numeric NOT NULL DEFAULT 0 CHECK (extra_gb >= 0)
);
`;
}

export async function migrateQuota(db: QuotaQueryable, schema = "public"): Promise<void> {
  await db.query(`BEGIN; SELECT pg_advisory_xact_lock(hashtext('cumulus-quota-migrate')); ${quotaSchemaSql(schema)} COMMIT;`);
}

export class PgQuotaRepository implements QuotaRepository {
  readonly #db: QuotaQueryable;
  readonly #t: string;

  constructor(options: { db: QuotaQueryable; schema?: string }) {
    const schema = options.schema ?? "public";
    if (!IDENT.test(schema)) throw new Error(`Bad schema name: ${schema}`);
    this.#db = options.db;
    this.#t = `"${schema}".quota_usage`;
  }

  async usage(cid: string): Promise<Record<QuotaProduct, number> | undefined> {
    // The row lock can't cover a person with no row yet (their first upload); this lock on the CID can,
    // so two first uploads at once are charged one after the other too.
    await this.#db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`cumulus-quota|${this.#t}|${cid}`]);
    const { rows } = await this.#db.query(`SELECT mail_bytes, cloud_bytes FROM ${this.#t} WHERE cid = $1 FOR UPDATE`, [cid]);
    return rows[0] ? { mail: Number(rows[0].mail_bytes), cloud: Number(rows[0].cloud_bytes) } : undefined;
  }
  /** For the meter: no lock, so showing it never waits for (or holds up) an upload. */
  async peekUsage(cid: string): Promise<Record<QuotaProduct, number> | undefined> {
    const { rows } = await this.#db.query(`SELECT mail_bytes, cloud_bytes FROM ${this.#t} WHERE cid = $1`, [cid]);
    return rows[0] ? { mail: Number(rows[0].mail_bytes), cloud: Number(rows[0].cloud_bytes) } : undefined;
  }
  async putUsage(cid: string, row: Record<QuotaProduct, number>): Promise<void> {
    await this.#db.query(
      `INSERT INTO ${this.#t} (cid, mail_bytes, cloud_bytes) VALUES ($1, $2, $3)
       ON CONFLICT (cid) DO UPDATE SET mail_bytes = EXCLUDED.mail_bytes, cloud_bytes = EXCLUDED.cloud_bytes`,
      [cid, Math.round(row.mail), Math.round(row.cloud)],
    );
  }
  async extraGb(cid: string): Promise<number | undefined> {
    const { rows } = await this.#db.query(`SELECT extra_gb FROM ${this.#t} WHERE cid = $1`, [cid]);
    const gb = rows[0] ? Number(rows[0].extra_gb) : 0;
    return gb > 0 ? gb : undefined;
  }
  async setExtraGb(cid: string, gb: number): Promise<void> {
    await this.#db.query(
      `INSERT INTO ${this.#t} (cid, extra_gb) VALUES ($1, $2) ON CONFLICT (cid) DO UPDATE SET extra_gb = EXCLUDED.extra_gb`,
      [cid, Math.max(0, gb)],
    );
  }
}
