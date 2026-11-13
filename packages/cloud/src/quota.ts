/**
 * One storage quota per Cumulus://ID, shared by every product that keeps a person's files,
 * the way one Google account's storage is shared by Drive and Gmail.
 * The free tier is 15 GB (FREE_ENTITLEMENTS.storageGb in @infinitum/cid).
 */

export type QuotaProduct = "mail" | "cloud";

export const GB = 1_000_000_000;
export const FREE_STORAGE_GB = 15;

export class QuotaError extends Error {
  readonly code = "quota_exceeded";
  constructor(message: string) {
    super(message);
  }
}

export interface QuotaUsage {
  usedBytes: number;
  limitBytes: number;
  byProduct: Record<QuotaProduct, number>;
  pct: number;
  label: string;
}

/** Storage boundary: plain Maps so it persists with the same snapshot helper as CID. */
export class QuotaStore {
  usage = new Map<string, Record<QuotaProduct, number>>();
  /** Extra GB on top of the free tier for paid plans, by CID. */
  extraGb = new Map<string, number>();
}

/**
 * Quota storage boundary (relational storage plan, phase 5): StorageQuota reads and writes only
 * through this interface, one person's usage at a time, with every change an explicit put, so a
 * database (quota_usage) can replace the in-memory one.
 */
export interface QuotaRepository {
  usage(cid: string): Promise<Record<QuotaProduct, number> | undefined>;
  putUsage(cid: string, row: Record<QuotaProduct, number>): Promise<void>;
  extraGb(cid: string): Promise<number | undefined>;
  /** 0 or less removes the extra storage. */
  setExtraGb(cid: string, gb: number): Promise<void>;
  /** Optional: usage for display, without the lock `usage` takes for a charge. */
  peekUsage?(cid: string): Promise<Record<QuotaProduct, number> | undefined>;
}

/** Today's QuotaStore Maps, snapshot format unchanged. */
export class MapQuotaRepository implements QuotaRepository {
  readonly store: QuotaStore;
  constructor(store: QuotaStore) {
    this.store = store;
  }
  async usage(cid: string) {
    return this.store.usage.get(cid);
  }
  async putUsage(cid: string, row: Record<QuotaProduct, number>) {
    this.store.usage.set(cid, row);
  }
  async extraGb(cid: string) {
    return this.store.extraGb.get(cid);
  }
  async setExtraGb(cid: string, gb: number) {
    if (gb <= 0) this.store.extraGb.delete(cid);
    else this.store.extraGb.set(cid, gb);
  }
}

/** Test double that copies values in and out, as a database does. */
export class CopyingQuotaRepository implements QuotaRepository {
  readonly #inner: MapQuotaRepository;
  constructor(store: QuotaStore) {
    this.#inner = new MapQuotaRepository(store);
  }
  async usage(cid: string) { const r = await this.#inner.usage(cid); return r && { ...r }; }
  async putUsage(cid: string, row: Record<QuotaProduct, number>) { return this.#inner.putUsage(cid, { ...row }); }
  async extraGb(cid: string) { return this.#inner.extraGb(cid); }
  async setExtraGb(cid: string, gb: number) { return this.#inner.setExtraGb(cid, gb); }
}

export class StorageQuota {
  readonly store: QuotaStore;
  readonly repo: QuotaRepository;
  private readonly baseGb: number;

  constructor(opts: { store?: QuotaStore; repository?: QuotaRepository; freeGb?: number } = {}) {
    this.store = opts.store ?? new QuotaStore();
    this.repo = opts.repository ?? new MapQuotaRepository(this.store);
    this.baseGb = opts.freeGb ?? FREE_STORAGE_GB;
  }

  async limitBytes(cid: string): Promise<number> {
    return (this.baseGb + ((await this.repo.extraGb(cid)) ?? 0)) * GB;
  }

  private async row(cid: string): Promise<Record<QuotaProduct, number>> {
    return { mail: 0, cloud: 0, ...(await this.repo.usage(cid)) };
  }

  /** The meter, for display and for a quick "will it fit" check. charge() checks again under its lock. */
  async usage(cid: string): Promise<QuotaUsage> {
    const row = this.repo.peekUsage ? { mail: 0, cloud: 0, ...(await this.repo.peekUsage(cid)) } : await this.row(cid);
    const usedBytes = row.mail + row.cloud;
    const limitBytes = await this.limitBytes(cid);
    const pct = Math.min(100, (usedBytes / limitBytes) * 100);
    return { usedBytes, limitBytes, byProduct: row, pct, label: `${formatBytes(usedBytes)} of ${formatBytes(limitBytes)}` };
  }

  async canFit(cid: string, bytes: number): Promise<boolean> {
    const { usedBytes, limitBytes } = await this.usage(cid);
    return usedBytes + bytes <= limitBytes;
  }

  /** Use storage. Throws QuotaError, and changes nothing, when it would go over the plan. */
  async charge(cid: string, product: QuotaProduct, bytes: number): Promise<void> {
    if (!Number.isFinite(bytes) || bytes < 0) throw new RangeError("bytes must be a positive number");
    const row = await this.row(cid);
    if (row.mail + row.cloud + bytes > (await this.limitBytes(cid))) {
      throw new QuotaError("Your Cumulus storage is full. Free up space in Mail or Cloud, or add storage.");
    }
    row[product] += bytes;
    await this.repo.putUsage(cid, row);
  }

  async release(cid: string, product: QuotaProduct, bytes: number): Promise<void> {
    const row = await this.row(cid);
    row[product] = Math.max(0, row[product] - Math.max(0, bytes));
    await this.repo.putUsage(cid, row);
  }

  /** Paid storage on top of the free 15 GB. */
  setExtraGb(cid: string, gb: number): Promise<void> {
    return this.repo.setExtraGb(cid, gb);
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}
