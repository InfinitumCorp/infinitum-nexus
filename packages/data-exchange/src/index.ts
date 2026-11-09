export * from "./types.ts";
export * from "./consent.ts";
export * from "./catalog.ts";
export * from "./marketplace.ts";
export * from "./revshare.ts";
export * from "./collectors.ts";
export * from "./cdat.ts";

import { ConsentManager } from "./consent.ts";
import { DatasetCatalog } from "./catalog.ts";
import { DataMarketplace } from "./marketplace.ts";
import { RevShareEngine } from "./revshare.ts";
import { CdatIssuer } from "./cdat.ts";
import { encodeCdatMint } from "./abi.ts";
import { readSnapshot, writeSnapshot } from "./store.ts";
import type { Ledger, Signer } from "@infinitum/firmament";
import type { ProductId } from "./types.ts";
import type { Payout } from "./revshare.ts";

/**
 * Main Data Exchange service.
 * Products call collectors that feed into catalog after consent.
 * A completed sale mints one soulbound CDAT license and, when a ledger is
 * attached, records the license and the payment split on Firmament (contributor share per product: PRODUCT_REV_SHARE_PCT; default 85%, FABRIC 70%).
 */
export const DATA_LICENSING = "data_licensing";

export class ConsentRequiredError extends Error {
  code = "consent_required" as const;
  constructor() {
    super("Grant data-licensing consent for this product before packaging data");
  }
}

export class DataExchange {
  consent: ConsentManager;
  catalog = new DatasetCatalog();
  marketplace: DataMarketplace;
  revshare = new RevShareEngine();
  cdat: CdatIssuer;
  private file?: string;
  private ledger?: Ledger;
  private signer?: Signer;
  private loading = false;
  private pending = Promise.resolve();

  constructor(ledger?: Ledger, signer?: Signer, file?: string) {
    this.ledger = ledger;
    this.signer = signer;
    this.file = file;
    this.consent = new ConsentManager(ledger, signer);
    this.marketplace = new DataMarketplace(this.catalog);
    this.cdat = new CdatIssuer(ledger, signer);
    const touch = () => {
      if (!this.loading) this.persist();
    };
    this.catalog.changed = touch;
    this.consent.changed = touch;
    this.marketplace.changed = touch;
    this.revshare.changed = touch;
    this.cdat.changed = touch;
  }

  /**
   * Package a dataset from a product. Requires an existing active data-licensing consent; never creates one.
   * Records the grant on Firmament when ledger is configured.
   */
  async packageDataset(params: {
    cid: string;
    product: ProductId;
    title: string;
    description: string;
    schema: string;
    sizeEstimate: number;
    privacyLevel: "anonymized" | "pseudonymized" | "aggregated";
    licenseTerms: string;
    priceUsd: number;
    scopes: string[];
  }) {
    const consent = this.consent.findActive(params.cid, params.product, DATA_LICENSING);
    if (!consent) throw new ConsentRequiredError();

    const ds = this.catalog.create({
      ownerCid: params.cid,
      product: params.product,
      title: params.title,
      description: params.description,
      schema: params.schema,
      sizeEstimate: params.sizeEstimate,
      privacyLevel: params.privacyLevel,
      licenseTerms: params.licenseTerms,
      priceUsd: params.priceUsd,
      consentId: consent.id,
    });

    await this.flush();
    return { dataset: ds, consent };
  }

  /** Revoke a consent and delist every dataset that relied on it. */
  async revokeConsent(consentId: string): Promise<{ revoked: boolean; delisted: number }> {
    const revoked = await this.consent.revoke(consentId);
    let delisted = 0;
    if (revoked) {
      for (const ds of this.catalog.list()) {
        if (ds.consentId === consentId && ds.status === "listed") {
          this.catalog.updateStatus(ds.id, "revoked");
          delisted++;
        }
      }
    }
    await this.flush();
    return { revoked, delisted };
  }

  listForSale() {
    return this.catalog.listListed();
  }

  async sell(datasetId: string, buyerId: string, amountUsd: number, licenseeAddress?: string) {
    const sale = this.marketplace.purchase({ datasetId, buyerId, amountUsd });
    if (!sale) return null;

    const ds = this.catalog.get(datasetId);
    if (!ds) return sale;

    const wallet = licenseeAddress ?? (/^0x[0-9a-fA-F]{40}$/.test(buyerId) ? buyerId : undefined);
    this.revshare.recordPayout(sale, ds.ownerCid);
    try {
      const token = await this.cdat.issue({
        datasetId,
        saleId: sale.id,
        licensee: buyerId,
        ownerCid: ds.ownerCid,
        terms: ds.licenseTerms,
        amountUsd,
        userShareUsd: sale.userShareUsd,
        platformShareUsd: sale.platformShareUsd,
        licenseeAddress: wallet,
      });
      sale.cdatTokenId = token.tokenId;
      this.persist();
      await this.flush();
      return sale;
    } catch (err) {
      this.marketplace.voidSale(sale.id);
      this.catalog.updateStatus(datasetId, "listed");
      this.revshare.drop(sale.id);
      throw err;
    }
  }

  /** Mark the owner's share (PRODUCT_REV_SHARE_PCT; default 85%, FABRIC 70%) paid and record the settlement on Firmament. */
  async settlePayout(saleId: string): Promise<Payout | null> {
    const payout = this.revshare.get(saleId);
    if (!payout || payout.paid) return null;
    if (!this.revshare.markPaid(saleId)) return null;
    if (this.ledger && this.signer) {
      await this.ledger.append(
        {
          type: "payment",
          product: "data-exchange",
          actor: "data-exchange",
          subject: saleId,
          payload: {
            kind: "payout",
            cid: payout.cid,
            amountUsd: payout.amountUsd,
            paidAt: payout.paidAt,
          },
        },
        this.signer,
      );
    }
    await this.flush();
    return this.revshare.get(saleId) ?? null;
  }

  mintCalldata(tokenId: string): string | undefined {
    const token = this.cdat.get(tokenId);
    if (!token) return undefined;
    const intent = this.cdat.mintIntent(token);
    if (!intent) return undefined;
    return encodeCdatMint(intent.args);
  }

  async load(): Promise<void> {
    if (!this.file) return;
    const snapshot = await readSnapshot(this.file);
    if (!snapshot) return;
    this.loading = true;
    try {
      this.catalog.importState(snapshot.datasets);
      this.consent.importState(snapshot.consents);
      this.marketplace.importState({ sales: snapshot.sales, brokers: snapshot.brokers });
      this.cdat.importState({ tokens: snapshot.tokens, nextOnchainId: snapshot.nextOnchainId });
      this.revshare.importState(snapshot.payouts);
    } finally {
      this.loading = false;
    }
  }

  private persist() {
    if (!this.file) return;
    const file = this.file;
    const snapshot = {
      datasets: this.catalog.exportState(),
      consents: this.consent.exportState(),
      sales: this.marketplace.exportState().sales,
      brokers: this.marketplace.exportState().brokers,
      tokens: this.cdat.exportState().tokens,
      nextOnchainId: this.cdat.exportState().nextOnchainId,
      payouts: this.revshare.exportState(),
    };
    this.pending = this.pending.then(() => writeSnapshot(file, snapshot));
  }

  async flush(): Promise<void> {
    await this.pending;
  }
}

export { createCumulusExchangeLabyrinth } from "./labyrinth.ts";
