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

export type RowsReadOp =
  | { op: "walletAccount"; cid: string }
  | { op: "walletByAddress"; address: string }
  | { op: "transfersOf"; cid: string; limit: number }
  | { op: "quotaUsage"; cid: string };

/** One write for public.nexus_commit_cid. `expect` absent: not checked; null: must not exist. */
export interface RowsWriteOp {
  kind: "wallet" | "transfer" | "quota";
  id: string;
  data: unknown;
  expect?: unknown;
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
  readonly wallet: WalletRepository;
  readonly quota: QuotaRepository;

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
  }

  /** Forget everything: a new request (or a re-run) starts from the server's current rows. */
  begin(): void {
    this.#wallets.clear();
    this.#addresses.clear();
    this.#quotas.clear();
    this.#transfers = [];
  }

  /** This request's writes, for the gateway to apply with the commit. */
  pending(): RowsWriteOp[] {
    const out: RowsWriteOp[] = [];
    for (const [cid, k] of this.#wallets) if (k.dirty) out.push({ kind: "wallet", id: cid, data: k.value, expect: k.base });
    for (const t of this.#transfers) out.push({ kind: "transfer", id: t.id, data: t, expect: null });
    for (const [cid, k] of this.#quotas) if (k.dirty) out.push({ kind: "quota", id: cid, data: k.value, expect: k.base });
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
