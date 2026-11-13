/**
 * FIRM Wallet and the storage quota as rows behind a gateway (the nexus-store edge function), for hosts
 * that can't open a Postgres connection (CUMULUS_STORE=gateway with CUMULUS_ROWS=wallet,quota).
 *
 * The same protocol as Cumulus://ID's RemoteCidRepository: reads go through the gateway's row lookups
 * (public.cid_read) and are remembered for the rest of the request; writes stay in memory until the
 * host commits, then pending() hands them over to be applied in the same database transaction as the
 * ledger and documents (public.nexus_commit_cid, see supabase/migrations/20261115_cumulus_rows_wallet_quota.sql).
 * Each write carries the value the request read, so if another server changed that wallet or quota in
 * the meantime the commit is refused and the host re-runs the request: a balance can't be spent twice.
 *
 * Requests on one instance must not overlap (RemoteState serializes them); begin() starts a fresh one.
 */
import type { QuotaProduct, QuotaRepository } from "@infinitum/cloud";
import type { WalletAccount, WalletRepository, WalletTransfer } from "@infinitum/firm";
import type { MailMessage, MailRepository, OutboundMail, StoredMailbox } from "@infinitum/mail";

export type RowsReadOp =
  | { op: "walletAccount"; cid: string }
  | { op: "walletByAddress"; address: string }
  | { op: "transfersOf"; cid: string; limit: number }
  | { op: "quotaUsage"; cid: string }
  | { op: "mailbox"; cid: string }
  | { op: "mailboxCids" }
  | { op: "mailAddress"; address: string }
  | { op: "mailOutbound"; id: string }
  | { op: "mailOpenOutbound" }
  | { op: "mailDueOutbound"; now: string; staleBefore: string; limit: number };

/** One write for public.nexus_commit_cid. `expect` absent: not checked; null: must not exist. */
export interface RowsWriteOp {
  kind: "wallet" | "transfer" | "quota" | "mailbox" | "message" | "messageDelete" | "mailAddress" | "outbound";
  id: string;
  data?: unknown;
  expect?: unknown;
  /** mailbox: the version this write stores. */
  version?: number;
}

/** A mailbox as read this request: its version and each message's position and JSON. */
interface MailboxRead {
  version: number | null;
  box: StoredMailbox | null;
  messages: Map<string, { ord: number; json: string }>;
}

export type RowsReader = (ops: RowsReadOp[]) => Promise<unknown[]>;

interface QuotaRow { mail: number; cloud: number; extraGb: number }

interface Known<T> {
  value: T | null;
  /** As read from the server this request (null: didn't exist). */
  base: T | null;
  dirty: boolean;
}

const copy = <T>(v: T): T => (v === undefined || v === null ? v : structuredClone(v));

export class RemoteRows {
  readonly #read: RowsReader;
  #wallets = new Map<string, Known<WalletAccount>>();
  #addresses = new Map<string, string | null>();
  #quotas = new Map<string, Known<QuotaRow>>();
  #transfers: WalletTransfer[] = [];
  #mailboxes = new Map<string, MailboxRead>();
  #mailWrites = new Map<string, StoredMailbox>();
  #mailAddresses = new Map<string, string | null>();
  #addressClaims = new Map<string, string>();
  #outbound = new Map<string, Known<OutboundMail>>();
  readonly wallet: WalletRepository;
  readonly quota: QuotaRepository;
  /**
   * Mail through the gateway. Message content is stored as given: hosts with a mail master key keep
   * mail with CUMULUS_STORE=postgres, where it is sealed.
   */
  readonly mail: MailRepository;

  constructor(read: RowsReader) {
    this.#read = read;
    const rows = this;
    this.wallet = {
      account: (cid) => rows.#wallet(cid),
      cidForAddress: (address) => rows.#cidForAddress(address),
      putAccount: async (account) => rows.#putWallet(account),
      transfersOf: (cid, limit) => rows.#transfersOf(cid, limit),
      putTransfer: async (t) => {
        rows.#transfers = rows.#transfers.filter((x) => x.id !== t.id).concat(copy(t));
      },
    };
    this.quota = {
      usage: async (cid) => {
        const row = await rows.#quota(cid);
        return row ? { mail: row.mail, cloud: row.cloud } : undefined;
      },
      putUsage: async (cid, usage: Record<QuotaProduct, number>) => {
        const row = (await rows.#quota(cid)) ?? { mail: 0, cloud: 0, extraGb: 0 };
        rows.#setQuota(cid, { ...row, mail: usage.mail, cloud: usage.cloud });
      },
      extraGb: async (cid) => {
        const gb = (await rows.#quota(cid))?.extraGb ?? 0;
        return gb > 0 ? gb : undefined;
      },
      setExtraGb: async (cid, gb) => {
        const row = (await rows.#quota(cid)) ?? { mail: 0, cloud: 0, extraGb: 0 };
        rows.#setQuota(cid, { ...row, extraGb: Math.max(0, gb) });
      },
    };
    this.mail = {
      mailbox: (cid) => rows.#mailbox(cid),
      putMailbox: async (box) => {
        rows.#mailWrites.set(box.cid, copy(box));
      },
      mailboxCids: async () => {
        const [cids] = (await rows.#read([{ op: "mailboxCids" }])) as string[][];
        return [...new Set([...(cids ?? []), ...rows.#mailWrites.keys()])];
      },
      cidForAddress: (address) => rows.#mailCid(address),
      claimAddress: async (address, cid) => {
        const key = address.trim().toLowerCase();
        const owner = await rows.#mailCid(key);
        if (owner && owner !== cid) return false;
        if (!owner) rows.#addressClaims.set(key, cid);
        rows.#mailAddresses.set(key, cid);
        return true;
      },
      outbound: async (id) => copy((await rows.#job(id)) ?? undefined),
      putOutbound: async (job) => {
        const k = rows.#outbound.get(job.id);
        if (k) {
          k.value = copy(job);
          k.dirty = true;
        } else rows.#outbound.set(job.id, { value: copy(job), base: null, dirty: true });
      },
      openOutbound: async () => {
        const [stored] = (await rows.#read([{ op: "mailOpenOutbound" }])) as OutboundMail[][];
        return rows.#overlay(stored ?? []).filter((j) => j.status === "queued" || j.status === "sending");
      },
      dueOutbound: async (now, staleBefore, limit) => {
        const [stored] = (await rows.#read([{ op: "mailDueOutbound", now, staleBefore, limit }])) as OutboundMail[][];
        const due = (j: OutboundMail) =>
          j.status === "sending" ? Date.parse(j.claimedAt ?? "") < Date.parse(staleBefore) : j.status === "queued" && (!j.nextAttemptAt || Date.parse(j.nextAttemptAt) <= Date.parse(now));
        return rows.#overlay(stored ?? []).filter(due).slice(0, limit);
      },
    };
  }

  /** Jobs as stored, with this request's changes on top; remembers each as read so a write checks it. */
  #overlay(stored: OutboundMail[]): OutboundMail[] {
    for (const j of stored) if (!this.#outbound.has(j.id)) this.#outbound.set(j.id, { value: copy(j), base: j, dirty: false });
    const ids = new Set(stored.map((j) => j.id));
    for (const [id, k] of this.#outbound) if (k.dirty && !ids.has(id) && k.value) ids.add(id);
    return [...ids].map((id) => copy(this.#outbound.get(id)!.value!)).filter(Boolean);
  }

  async #job(id: string): Promise<OutboundMail | null> {
    let k = this.#outbound.get(id);
    if (!k) {
      const [row] = (await this.#read([{ op: "mailOutbound", id }])) as (OutboundMail | null)[];
      k = { value: copy(row ?? null), base: row ?? null, dirty: false };
      this.#outbound.set(id, k);
    }
    return k.value;
  }

  async #mailCid(address: string): Promise<string | undefined> {
    const key = address.trim().toLowerCase();
    if (!this.#mailAddresses.has(key)) {
      const [cid] = (await this.#read([{ op: "mailAddress", address: key }])) as (string | null)[];
      this.#mailAddresses.set(key, cid ?? null);
    }
    return this.#mailAddresses.get(key) ?? undefined;
  }

  async #mailbox(cid: string): Promise<StoredMailbox | undefined> {
    const written = this.#mailWrites.get(cid);
    if (written) return copy(written);
    let read = this.#mailboxes.get(cid);
    if (!read) {
      const [row] = (await this.#read([{ op: "mailbox", cid }])) as ({ version: number; data: Omit<StoredMailbox, "messages">; messages: { id: string; ord: number; data: MailMessage }[] } | null)[];
      const messages = new Map<string, { ord: number; json: string }>();
      let box: StoredMailbox | null = null;
      if (row) {
        box = { ...row.data, cid, messages: row.messages.map((m) => m.data) } as StoredMailbox;
        for (const m of row.messages) messages.set(m.id, { ord: Number(m.ord), json: JSON.stringify(m.data) });
      }
      read = { version: row ? Number(row.version) : null, box, messages };
      this.#mailboxes.set(cid, read);
    }
    return copy(read.box) ?? undefined;
  }

  /** A changed mailbox as writes: the mailbox row (checked against the version read), then only the messages that changed. */
  #mailboxOps(box: StoredMailbox): RowsWriteOp[] {
    const read = this.#mailboxes.get(box.cid);
    const before = read?.messages ?? new Map<string, { ord: number; json: string }>();
    const { messages, ...meta } = box;
    const ops: RowsWriteOp[] = [{ kind: "mailbox", id: box.cid, data: meta, version: (read?.version ?? 0) + 1, expect: read?.version ?? null }];
    const kept = new Set<string>();
    let prev = -Infinity;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      const known = before.get(m.id);
      const ord = known && known.ord > prev ? known.ord : Number.isFinite(prev) ? prev + 1 : 0;
      prev = ord;
      kept.add(m.id);
      if (!known || known.ord !== ord || known.json !== JSON.stringify(m)) ops.push({ kind: "message", id: `${box.cid}|${m.id}`, data: { ord, message: m } });
    }
    for (const id of before.keys()) if (!kept.has(id)) ops.push({ kind: "messageDelete", id: `${box.cid}|${id}` });
    return ops;
  }

  /** Forget everything: a new request (or a re-run) starts from the server's current rows. */
  begin(): void {
    this.#wallets.clear();
    this.#addresses.clear();
    this.#quotas.clear();
    this.#transfers = [];
    this.#mailboxes.clear();
    this.#mailWrites.clear();
    this.#mailAddresses.clear();
    this.#addressClaims.clear();
    this.#outbound.clear();
  }

  /** This request's writes, for the gateway to apply with the commit. */
  pending(): RowsWriteOp[] {
    const out: RowsWriteOp[] = [];
    for (const [cid, k] of this.#wallets) if (k.dirty) out.push({ kind: "wallet", id: cid, data: k.value, expect: k.base });
    for (const t of this.#transfers) out.push({ kind: "transfer", id: t.id, data: t, expect: null });
    for (const [cid, k] of this.#quotas) if (k.dirty) out.push({ kind: "quota", id: cid, data: k.value, expect: k.base });
    for (const [address, cid] of this.#addressClaims) out.push({ kind: "mailAddress", id: address, data: cid, expect: null });
    for (const box of this.#mailWrites.values()) out.push(...this.#mailboxOps(box));
    for (const [id, k] of this.#outbound) if (k.dirty) out.push({ kind: "outbound", id, data: k.value, expect: k.base });
    return out;
  }

  async #wallet(cid: string): Promise<WalletAccount | undefined> {
    let k = this.#wallets.get(cid);
    if (!k) {
      const [row] = (await this.#read([{ op: "walletAccount", cid }])) as (WalletAccount | null)[];
      k = { value: copy(row ?? null), base: row ?? null, dirty: false };
      this.#wallets.set(cid, k);
    }
    return copy(k.value) ?? undefined;
  }

  #putWallet(account: WalletAccount) {
    const k = this.#wallets.get(account.cid);
    // A wallet written without being read first (opening a new one) must not exist yet.
    if (k) {
      k.value = copy(account);
      k.dirty = true;
    } else this.#wallets.set(account.cid, { value: copy(account), base: null, dirty: true });
    this.#addresses.set(account.address.toLowerCase(), account.cid);
  }

  async #cidForAddress(address: string): Promise<string | undefined> {
    const key = address.toLowerCase();
    if (!this.#addresses.has(key)) {
      const [cid] = (await this.#read([{ op: "walletByAddress", address: key }])) as (string | null)[];
      this.#addresses.set(key, cid ?? null);
    }
    return this.#addresses.get(key) ?? undefined;
  }

  async #transfersOf(cid: string, limit: number): Promise<WalletTransfer[]> {
    const [stored] = (await this.#read([{ op: "transfersOf", cid, limit }])) as WalletTransfer[][];
    const mine = this.#transfers.filter((t) => t.from === cid || t.to === cid);
    const byId = new Map<string, WalletTransfer>();
    for (const t of [...(stored ?? []), ...mine]) byId.set(t.id, t);
    return [...byId.values()]
      .sort((a, b) => (a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1))
      .slice(0, limit)
      .map(copy);
  }

  async #quota(cid: string): Promise<QuotaRow | undefined> {
    let k = this.#quotas.get(cid);
    if (!k) {
      const [row] = (await this.#read([{ op: "quotaUsage", cid }])) as (QuotaRow | null)[];
      const normal = row ? { mail: Number(row.mail), cloud: Number(row.cloud), extraGb: Number(row.extraGb) } : null;
      k = { value: copy(normal), base: row ?? null, dirty: false };
      this.#quotas.set(cid, k);
    }
    return copy(k.value) ?? undefined;
  }

  #setQuota(cid: string, row: QuotaRow) {
    const k = this.#quotas.get(cid)!; // read just before by every caller
    k.value = { mail: Math.round(row.mail), cloud: Math.round(row.cloud), extraGb: row.extraGb };
    k.dirty = true;
  }
}
