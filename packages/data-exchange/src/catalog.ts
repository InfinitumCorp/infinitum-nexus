import type { Dataset, ProductId } from "./types.ts";
import { DEFAULT_REV_SHARE_PCT, PRODUCT_REV_SHARE_PCT } from "./revshare.ts";

/**
 * Dataset catalog. Users package eligible data from any Infinitum product.
 */
export class DatasetCatalog {
  private datasets = new Map<string, Dataset>();
  changed?: () => void;

  create(params: Omit<Dataset, "id" | "createdAt" | "status" | "revSharePct"> & { status?: Dataset["status"]; revSharePct?: number }): Dataset {
    const id = `ds_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const ds: Dataset = {
      ...params,
      id,
      status: params.status ?? "draft",
      createdAt: new Date().toISOString(),
      revSharePct: params.revSharePct ?? PRODUCT_REV_SHARE_PCT[params.product] ?? DEFAULT_REV_SHARE_PCT,
    };
    this.datasets.set(id, ds);
    this.changed?.();
    return ds;
  }

  list(ownerCid?: string, product?: ProductId): Dataset[] {
    return [...this.datasets.values()].filter((d) => {
      if (ownerCid && d.ownerCid !== ownerCid) return false;
      if (product && d.product !== product) return false;
      return true;
    });
  }

  get(id: string): Dataset | undefined {
    return this.datasets.get(id);
  }

  updateStatus(id: string, status: Dataset["status"]): Dataset | undefined {
    const ds = this.datasets.get(id);
    if (!ds) return undefined;
    ds.status = status;
    this.changed?.();
    return ds;
  }

  exportState(): Dataset[] {
    return [...this.datasets.values()];
  }

  importState(records: Dataset[]) {
    this.datasets = new Map(records.map((d) => [d.id, d]));
  }

  listListed(): Dataset[] {
    return this.list().filter((d) => d.status === "listed");
  }
}
