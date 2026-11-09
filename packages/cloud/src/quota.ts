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

export class StorageQuota {
  readonly store: QuotaStore;
  private readonly baseGb: number;

  constructor(opts: { store?: QuotaStore; freeGb?: number } = {}) {
    this.store = opts.store ?? new QuotaStore();
    this.baseGb = opts.freeGb ?? FREE_STORAGE_GB;
  }

  limitBytes(cid: string): number {
    return (this.baseGb + (this.store.extraGb.get(cid) ?? 0)) * GB;
  }

  private row(cid: string): Record<QuotaProduct, number> {
    let row = this.store.usage.get(cid);
    if (!row) {
      row = { mail: 0, cloud: 0 };
      this.store.usage.set(cid, row);
    }
    return row;
  }

  usage(cid: string): QuotaUsage {
    const row = { ...this.row(cid) };
    const usedBytes = row.mail + row.cloud;
    const limitBytes = this.limitBytes(cid);
    const pct = Math.min(100, (usedBytes / limitBytes) * 100);
    return { usedBytes, limitBytes, byProduct: row, pct, label: `${formatBytes(usedBytes)} of ${formatBytes(limitBytes)}` };
  }

  canFit(cid: string, bytes: number): boolean {
    const { usedBytes, limitBytes } = this.usage(cid);
    return usedBytes + bytes <= limitBytes;
  }

  /** Use storage. Throws QuotaError, and changes nothing, when it would go over the plan. */
  charge(cid: string, product: QuotaProduct, bytes: number) {
    if (!Number.isFinite(bytes) || bytes < 0) throw new RangeError("bytes must be a positive number");
    if (!this.canFit(cid, bytes)) {
      throw new QuotaError("Your Cumulus storage is full. Free up space in Mail or Cloud, or add storage.");
    }
    this.row(cid)[product] += bytes;
  }

  release(cid: string, product: QuotaProduct, bytes: number) {
    const row = this.row(cid);
    row[product] = Math.max(0, row[product] - Math.max(0, bytes));
  }

  /** Paid storage on top of the free 15 GB. */
  setExtraGb(cid: string, gb: number) {
    if (gb <= 0) this.store.extraGb.delete(cid);
    else this.store.extraGb.set(cid, gb);
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}
