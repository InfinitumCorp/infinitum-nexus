/**
 * Cumulus://Cloud store.
 * Object storage with licensing metadata. Files count against the owner's shared Cumulus
 * storage quota, and sharing a file sends the recipient a Cumulus://Mail notice.
 */
import type { StorageQuota } from "./quota.ts";

export interface CloudObject {
  key: string;
  owner: string;
  size: number;
  license: string;
  createdAt: string;
  sharedWith?: string[];
}

/** How Cloud tells people about shares; Cumulus://Mail implements this. */
export interface CloudNotifier {
  shared(input: { owner: string; recipient: string; key: string }): void | Promise<void>;
}

export interface CloudStoreOptions {
  quota?: StorageQuota;
  notifier?: CloudNotifier;
}

export class CloudStore {
  private objects = new Map<string, CloudObject>();
  private readonly quota?: StorageQuota;
  private readonly notifier?: CloudNotifier;

  constructor(opts: CloudStoreOptions = {}) {
    this.quota = opts.quota;
    this.notifier = opts.notifier;
  }

  put(key: string, owner: string, size: number, license = "personal"): CloudObject {
    if (!Number.isFinite(size) || size < 0) throw new RangeError("size must be a finite number of bytes");
    const previous = this.objects.get(key);
    if (previous && previous.owner !== owner) throw new Error("That file belongs to someone else");
    if (this.quota) {
      const delta = size - (previous?.size ?? 0);
      if (delta > 0) this.quota.charge(owner, "cloud", delta);
      else this.quota.release(owner, "cloud", -delta);
    }
    const obj: CloudObject = { key, owner, size, license, createdAt: new Date().toISOString(), sharedWith: previous?.sharedWith };
    this.objects.set(key, obj);
    return obj;
  }

  get(key: string): CloudObject | undefined {
    return this.objects.get(key);
  }

  list(owner: string): CloudObject[] {
    return [...this.objects.values()].filter((o) => o.owner === owner);
  }

  remove(key: string, owner: string): boolean {
    const obj = this.objects.get(key);
    if (!obj || obj.owner !== owner) return false;
    this.objects.delete(key);
    this.quota?.release(owner, "cloud", obj.size);
    return true;
  }

  async share(key: string, owner: string, recipient: string): Promise<CloudObject> {
    const obj = this.objects.get(key);
    if (!obj || obj.owner !== owner) throw new Error("No such file in your Cloud");
    obj.sharedWith = [...new Set([...(obj.sharedWith ?? []), recipient])];
    await this.notifier?.shared({ owner, recipient, key });
    return obj;
  }
}
