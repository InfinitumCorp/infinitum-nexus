import type { Dataset, LicenseSale, DataBroker } from "./types.ts";
import type { DatasetCatalog } from "./catalog.ts";

/**
 * Marketplace for data brokers to discover and license datasets.
 * Settlement can be in USDC or product tokens; CDAT license tokens issued on Firmament.
 */
export class DataMarketplace {
  private sales = new Map<string, LicenseSale>();
  private brokers = new Map<string, DataBroker>();
  private catalog: DatasetCatalog;
  changed?: () => void;

  constructor(catalog: DatasetCatalog) {
    this.catalog = catalog;
  }

  registerBroker(broker: Omit<DataBroker, "id">): DataBroker {
    const id = `broker_${Date.now()}`;
    const b: DataBroker = { ...broker, id };
    this.brokers.set(id, b);
    this.changed?.();
    return b;
  }

  listBrokers(): DataBroker[] {
    return [...this.brokers.values()];
  }

  purchase(params: {
    datasetId: string;
    buyerId: string;
    amountUsd: number;
  }): LicenseSale | null {
    const ds = this.catalog.get(params.datasetId);
    if (!ds || ds.status !== "listed") return null;
    if (!Number.isFinite(params.amountUsd) || params.amountUsd <= 0) return null;

    const amountCents = Math.round(params.amountUsd * 100);
    const userCents = Math.round((amountCents * ds.revSharePct) / 100);
    const userShare = userCents / 100;
    const platformShare = (amountCents - userCents) / 100;

    const sale: LicenseSale = {
      id: `sale_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      datasetId: params.datasetId,
      buyerId: params.buyerId,
      amountUsd: amountCents / 100,
      userShareUsd: userShare,
      platformShareUsd: platformShare,
      soldAt: new Date().toISOString(),
      status: "completed",
    };

    this.sales.set(sale.id, sale);
    this.catalog.updateStatus(params.datasetId, "sold");
    this.changed?.();
    return sale;
  }

  /** Undo a purchase that never finished (the license was not issued). */
  voidSale(saleId: string): void {
    const sale = this.sales.get(saleId);
    if (!sale) return;
    this.sales.delete(saleId);
    this.changed?.();
  }

  listSales(ownerCid?: string): LicenseSale[] {
    const all = [...this.sales.values()];
    if (!ownerCid) return all;
    return all.filter((s) => {
      const ds = this.catalog.get(s.datasetId);
      return ds?.ownerCid === ownerCid;
    });
  }

  getSale(id: string): LicenseSale | undefined {
    return this.sales.get(id);
  }

  exportState(): { sales: LicenseSale[]; brokers: DataBroker[] } {
    return { sales: [...this.sales.values()], brokers: [...this.brokers.values()] };
  }

  importState(state: { sales: LicenseSale[]; brokers: DataBroker[] }) {
    this.sales = new Map(state.sales.map((s) => [s.id, s]));
    this.brokers = new Map(state.brokers.map((b) => [b.id, b]));
  }
}
