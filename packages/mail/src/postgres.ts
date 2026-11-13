/**
 * Cumulus://Mail on PostgreSQL (relational storage plan, phase 5, Mail step 1): one row per mailbox
 * (mail_mailboxes), per address or alias (mail_addresses) and per outbound job (mail_outbound).
 *
 * - A mailbox read takes a row lock (SELECT … FOR UPDATE), so inside a request's transaction two
 *   deliveries to the same person are applied one after the other and neither is lost.
 * - Addresses are claimed with INSERT … ON CONFLICT, so two people can't take the same one.
 * - Due outbound jobs are read with FOR UPDATE SKIP LOCKED, only as many as a sender takes: two
 *   senders running at once take different jobs, and none is sent twice.
 * - With a tunnel, message subjects, bodies and attachments are sealed to the owner before they're
 *   written (the same envelopes as the snapshot's at-rest sealing) and opened when read.
 *
 * The connection is passed in (a `pg` client inside the request's transaction, Hyperdrive, or a
 * request scope); off unless a PostOffice is given this repository.
 */
import { openMailbox, sealMailbox } from "./at-rest.ts";
import type { OutboundMail, StoredMailbox } from "./postoffice.ts";
import type { MailRepository } from "./repository.ts";
import type { CumulusTunnel } from "./tunnel.ts";

export interface MailQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

export function mailSchemaSql(schema = "public"): string {
  if (!IDENT.test(schema)) throw new Error(`Bad schema name: ${schema}`);
  const s = `"${schema}"`;
  return `
CREATE SCHEMA IF NOT EXISTS ${s};
CREATE TABLE IF NOT EXISTS ${s}.mail_mailboxes (
  cid text PRIMARY KEY,
  seq bigserial,
  data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS ${s}.mail_addresses (
  address text PRIMARY KEY CHECK (address = lower(address)),
  cid text NOT NULL
);
CREATE INDEX IF NOT EXISTS mail_addresses_cid ON ${s}.mail_addresses (cid);
CREATE TABLE IF NOT EXISTS ${s}.mail_outbound (
  id text PRIMARY KEY,
  seq bigserial,
  status text NOT NULL CHECK (status IN ('queued', 'sending', 'sent', 'failed')),
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS mail_outbound_open ON ${s}.mail_outbound (seq) WHERE status IN ('queued', 'sending');
`;
}

export async function migrateMail(db: MailQueryable, schema = "public"): Promise<void> {
  await db.query(`BEGIN; SELECT pg_advisory_xact_lock(hashtext('cumulus-mail-migrate')); ${mailSchemaSql(schema)} COMMIT;`);
}

export class PgMailRepository implements MailRepository {
  readonly #db: MailQueryable;
  readonly #s: string;
  readonly #tunnel?: CumulusTunnel;

  constructor(options: { db: MailQueryable; schema?: string; tunnel?: CumulusTunnel }) {
    const schema = options.schema ?? "public";
    if (!IDENT.test(schema)) throw new Error(`Bad schema name: ${schema}`);
    this.#db = options.db;
    this.#s = `"${schema}"`;
    this.#tunnel = options.tunnel;
  }

  async mailbox(cid: string): Promise<StoredMailbox | undefined> {
    const { rows } = await this.#db.query(`SELECT data FROM ${this.#s}.mail_mailboxes WHERE cid = $1 FOR UPDATE`, [cid]);
    if (!rows[0]) return undefined;
    const box = rows[0].data as StoredMailbox;
    if (this.#tunnel) openMailbox(box, this.#tunnel, cid);
    return box;
  }

  async putMailbox(box: StoredMailbox): Promise<void> {
    const data = this.#tunnel ? sealMailbox(box, this.#tunnel) : box;
    await this.#db.query(
      `INSERT INTO ${this.#s}.mail_mailboxes (cid, data) VALUES ($1, $2) ON CONFLICT (cid) DO UPDATE SET data = EXCLUDED.data`,
      [box.cid, JSON.stringify(data)],
    );
  }

  async mailboxCids(): Promise<string[]> {
    const { rows } = await this.#db.query(`SELECT cid FROM ${this.#s}.mail_mailboxes ORDER BY seq`);
    return rows.map((r) => r.cid as string);
  }

  async cidForAddress(address: string): Promise<string | undefined> {
    const { rows } = await this.#db.query(`SELECT cid FROM ${this.#s}.mail_addresses WHERE address = $1`, [address.trim().toLowerCase()]);
    return rows[0]?.cid;
  }

  async claimAddress(address: string, cid: string): Promise<boolean> {
    const key = address.trim().toLowerCase();
    const { rows } = await this.#db.query(
      `INSERT INTO ${this.#s}.mail_addresses (address, cid) VALUES ($1, $2) ON CONFLICT (address) DO NOTHING RETURNING cid`,
      [key, cid],
    );
    if (rows.length) return true;
    return (await this.cidForAddress(key)) === cid;
  }

  async outbound(id: string): Promise<OutboundMail | undefined> {
    const { rows } = await this.#db.query(`SELECT data FROM ${this.#s}.mail_outbound WHERE id = $1 FOR UPDATE`, [id]);
    return rows[0]?.data;
  }

  async putOutbound(job: OutboundMail): Promise<void> {
    await this.#db.query(
      `INSERT INTO ${this.#s}.mail_outbound (id, status, data) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, data = EXCLUDED.data`,
      [job.id, job.status, JSON.stringify(job)],
    );
  }

  async openOutbound(): Promise<OutboundMail[]> {
    const { rows } = await this.#db.query(`SELECT data FROM ${this.#s}.mail_outbound WHERE status IN ('queued', 'sending') ORDER BY seq`);
    return rows.map((r) => r.data as OutboundMail);
  }

  async dueOutbound(now: string, staleBefore: string, limit: number): Promise<OutboundMail[]> {
    const { rows } = await this.#db.query(
      `SELECT data FROM ${this.#s}.mail_outbound
        WHERE (status = 'queued' AND (data->>'nextAttemptAt' IS NULL OR (data->>'nextAttemptAt')::timestamptz <= $1::timestamptz))
           OR (status = 'sending' AND (data->>'claimedAt')::timestamptz < $2::timestamptz)
        ORDER BY seq LIMIT $3 FOR UPDATE SKIP LOCKED`,
      [now, staleBefore, Math.max(0, Math.floor(limit))],
    );
    return rows.map((r) => r.data as OutboundMail);
  }
}
