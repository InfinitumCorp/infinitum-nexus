/**
 * Cumulus://Mail on PostgreSQL (relational storage plan, phase 5): one row per mailbox (mail_mailboxes:
 * owner, aliases, tasks, contacts, Clean state), per message (mail_messages), per address or alias
 * (mail_addresses) and per outbound job (mail_outbound). A write touches only the messages that changed.
 *
 * - A mailbox read takes a row lock (SELECT … FOR UPDATE), so inside a request's transaction two
 *   deliveries to the same person are applied one after the other and neither is lost.
 * - Addresses are claimed with INSERT … ON CONFLICT, so two people can't take the same one.
 * - Due outbound jobs are read with FOR UPDATE SKIP LOCKED, only as many as a sender takes: two
 *   senders running at once take different jobs, and none is sent twice.
 * - With a tunnel, message subjects, bodies and attachments are sealed to the owner before they're
 *   written (the same envelopes as the snapshot's at-rest sealing) and opened when read; an outbound
 *   job's subject and body are sealed to its sender. The tunnel keys themselves (wrapped with the
 *   master key) are kept in mail_tunnel_keys, so every server seals and opens with the same keys.
 *
 * The connection is passed in (a `pg` client inside the request's transaction, Hyperdrive, or a
 * request scope); off unless a PostOffice is given this repository.
 */
import { openMailbox, sealMailbox } from "./at-rest.ts";
import type { OutboundMail, StoredMailbox } from "./postoffice.ts";
import type { MailRepository } from "./repository.ts";
import type { CumulusTunnel, SealedEnvelope, StoredTunnelKeys } from "./tunnel.ts";
import type { MailMessage } from "./model.ts";

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
CREATE TABLE IF NOT EXISTS ${s}.mail_tunnel_keys (
  cid text PRIMARY KEY,
  data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS ${s}.mail_messages (
  cid text NOT NULL,
  id text NOT NULL,
  ord bigint NOT NULL,
  folder text NOT NULL,
  thread_id text NOT NULL,
  at text NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (cid, id)
);
CREATE INDEX IF NOT EXISTS mail_messages_order ON ${s}.mail_messages (cid, ord DESC);
CREATE INDEX IF NOT EXISTS mail_messages_folder ON ${s}.mail_messages (cid, folder, at DESC);
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
  /**
   * For each mailbox object this repository handed out, its messages as read (position and JSON, by
   * id), so writing it back touches only what changed. Kept per object, not per account: two requests
   * holding their own copies of one mailbox never compare against each other's.
   */
  readonly #seen = new WeakMap<object, Map<string, { ord: number; json: string }>>();

  /** Accounts whose tunnel keys are known to be the stored ones. */
  readonly #keysStored = new Set<string>();

  constructor(options: { db: MailQueryable; schema?: string; tunnel?: CumulusTunnel }) {
    const schema = options.schema ?? "public";
    if (!IDENT.test(schema)) throw new Error(`Bad schema name: ${schema}`);
    this.#db = options.db;
    this.#s = `"${schema}"`;
    this.#tunnel = options.tunnel;
  }

  /**
   * Make the tunnel hold the account's stored keys before anything is sealed or opened for it: adopt
   * them if they're stored, store this server's if it made them first. Keys are wrapped with the master
   * key, so they're safe at rest. If two servers make keys for one account at once, the first stored
   * wins and the other adopts it.
   */
  async #syncKeys(cid: string): Promise<void> {
    const tunnel = this.#tunnel;
    if (!tunnel || this.#keysStored.has(cid)) return;
    const read = async () => (await this.#db.query(`SELECT data FROM ${this.#s}.mail_tunnel_keys WHERE cid = $1`, [cid])).rows[0]?.data as StoredTunnelKeys | undefined;
    let stored = await read();
    if (!stored && tunnel.has(cid)) {
      const mine = tunnel.ensure(cid);
      const { rows } = await this.#db.query(
        `INSERT INTO ${this.#s}.mail_tunnel_keys (cid, data) VALUES ($1, $2) ON CONFLICT (cid) DO NOTHING RETURNING cid`,
        [cid, JSON.stringify(mine)],
      );
      if (!rows.length) stored = await read();
      // Keys written here are checked again next time: the transaction they went in may roll back.
      else return;
    }
    if (!stored) return; // nobody has keys yet; they're stored with the account's first write
    tunnel.adopt(stored);
    this.#keysStored.add(cid);
  }

  async mailbox(cid: string): Promise<StoredMailbox | undefined> {
    await this.#syncKeys(cid);
    const { rows } = await this.#db.query(`SELECT data FROM ${this.#s}.mail_mailboxes WHERE cid = $1 FOR UPDATE`, [cid]);
    if (!rows[0]) return undefined;
    const { messages: legacy, ...meta } = rows[0].data as StoredMailbox;
    const stored = await this.#db.query(`SELECT id, ord, data FROM ${this.#s}.mail_messages WHERE cid = $1 ORDER BY ord DESC`, [cid]);
    // Written before messages had rows: they move into rows on the next write.
    const fromRows = stored.rows.length > 0 || !legacy?.length;
    const messages: MailMessage[] = fromRows ? stored.rows.map((r) => r.data as MailMessage) : legacy;
    const box = { ...meta, cid, messages } as StoredMailbox;
    if (this.#tunnel) openMailbox(box, this.#tunnel, cid);
    // Remember each message as the PostOffice sees it (opened), to write back only what changes.
    const seen = new Map<string, { ord: number; json: string }>();
    if (fromRows) stored.rows.forEach((r, i) => seen.set(r.id, { ord: Number(r.ord), json: JSON.stringify(messages[i]) }));
    this.#seen.set(box, seen);
    return box;
  }

  /**
   * The mailbox row (owner, aliases, tasks, contacts, Clean state) and one row per message. Only
   * messages that changed since they were read are written (sealed one by one with a tunnel), and
   * only removed ones are deleted.
   */
  async putMailbox(box: StoredMailbox): Promise<void> {
    await this.#syncKeys(box.cid);
    const { messages, ...meta } = box;
    await this.#db.query(
      `INSERT INTO ${this.#s}.mail_mailboxes (cid, data) VALUES ($1, $2) ON CONFLICT (cid) DO UPDATE SET data = EXCLUDED.data`,
      [box.cid, JSON.stringify(meta)],
    );
    // A mailbox not read here (new, or a copy) replaces all of the account's message rows.
    const before = this.#seen.get(box);
    const after = new Map<string, { ord: number; json: string }>();
    // Newest first in the list, so positions count up from the oldest. A message keeps its position
    // while it is still in order, so delivering one new message writes one row.
    let prev = -Infinity;
    const writes: { id: string; ord: number; m: MailMessage }[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      const known = before?.get(m.id);
      const ord = known && known.ord > prev ? known.ord : Number.isFinite(prev) ? prev + 1 : 0;
      prev = ord;
      const json = JSON.stringify(m);
      after.set(m.id, { ord, json });
      if (!known || known.ord !== ord || known.json !== json) writes.push({ id: m.id, ord, m });
    }
    for (const w of writes) {
      const stored = this.#tunnel ? sealMailbox({ ...box, messages: [w.m] }, this.#tunnel).messages[0] : w.m;
      await this.#db.query(
        `INSERT INTO ${this.#s}.mail_messages (cid, id, ord, folder, thread_id, at, data) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (cid, id) DO UPDATE SET ord = EXCLUDED.ord, folder = EXCLUDED.folder, thread_id = EXCLUDED.thread_id, at = EXCLUDED.at, data = EXCLUDED.data`,
        [box.cid, w.id, w.ord, w.m.folder, w.m.threadId, w.m.at, JSON.stringify(stored)],
      );
    }
    if (before) {
      const gone = [...before.keys()].filter((id) => !after.has(id));
      if (gone.length) await this.#db.query(`DELETE FROM ${this.#s}.mail_messages WHERE cid = $1 AND id = ANY($2::text[])`, [box.cid, gone]);
    } else {
      await this.#db.query(`DELETE FROM ${this.#s}.mail_messages WHERE cid = $1 AND NOT (id = ANY($2::text[]))`, [box.cid, [...after.keys()]]);
    }
    this.#seen.set(box, after);
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
    return rows[0] && (await this.#openJob(rows[0].data));
  }

  /** With a tunnel, a job's subject and body are sealed to the sender, like their copy in Sent. */
  #sealJob(job: OutboundMail): object {
    if (!this.#tunnel || job.body === undefined) return job;
    const { subject, body, ...rest } = job;
    this.#tunnel.ensure(job.fromCid);
    return { ...rest, subject: "", sealed: this.#tunnel.seal(job.fromCid, [job.fromCid], { subject, body }) };
  }

  async #openJob(data: OutboundMail & { sealed?: SealedEnvelope }): Promise<OutboundMail> {
    if (!data.sealed) return data;
    const { sealed, ...job } = data;
    if (!this.#tunnel) throw new Error(`Outbound job ${job.id} is sealed and this repository has no tunnel`);
    await this.#syncKeys(job.fromCid);
    const { payload } = this.#tunnel.open<{ subject: string; body: string }>(job.fromCid, sealed);
    return { ...job, subject: payload.subject, body: payload.body };
  }

  async putOutbound(job: OutboundMail): Promise<void> {
    await this.#syncKeys(job.fromCid);
    await this.#db.query(
      `INSERT INTO ${this.#s}.mail_outbound (id, status, data) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, data = EXCLUDED.data`,
      [job.id, job.status, JSON.stringify(this.#sealJob(job))],
    );
  }

  async openOutbound(): Promise<OutboundMail[]> {
    const { rows } = await this.#db.query(`SELECT data FROM ${this.#s}.mail_outbound WHERE status IN ('queued', 'sending') ORDER BY seq`);
    return Promise.all(rows.map((r) => this.#openJob(r.data)));
  }

  async dueOutbound(now: string, staleBefore: string, limit: number): Promise<OutboundMail[]> {
    const { rows } = await this.#db.query(
      `SELECT data FROM ${this.#s}.mail_outbound
        WHERE (status = 'queued' AND (data->>'nextAttemptAt' IS NULL OR (data->>'nextAttemptAt')::timestamptz <= $1::timestamptz))
           OR (status = 'sending' AND (data->>'claimedAt')::timestamptz < $2::timestamptz)
        ORDER BY seq LIMIT $3 FOR UPDATE SKIP LOCKED`,
      [now, staleBefore, Math.max(0, Math.floor(limit))],
    );
    return Promise.all(rows.map((r) => this.#openJob(r.data)));
  }
}
