/**
 * Product-specific data collectors for every Infinitum software product.
 * Each extracts eligible, consented, aggregated/anonymized data only.
 *
 * Rules:
 * - Always check consent first
 * - Never collect military/ODIN° or raw personal content for public exchange
 * - Prefer aggregated / anonymized
 * - Record provenance on Firmament
 * - Hardware products (POLLEN, ORBIS, NEMESIS, Flower, #THRONE) do not feed the public exchange
 */
import type { ProductId } from "./types.ts";
import type { DataExchange } from "./index.ts";

export interface CollectorResult {
  datasetId?: string;
  skippedReason?: string;
}

export abstract class ProductCollector {
  abstract product: ProductId;
  protected dx: DataExchange;
  constructor(dx: DataExchange) {
    this.dx = dx;
  }

  abstract collect(cid: string, opts?: Record<string, unknown>): Promise<CollectorResult> | CollectorResult;
}

function listDataset(
  dx: DataExchange,
  params: Parameters<DataExchange["packageDataset"]>[0],
): Promise<CollectorResult> {
  return dx.packageDataset(params).then(({ dataset }) => {
    dx.catalog.updateStatus(dataset.id, "listed");
    return { datasetId: dataset.id };
  });
}

/** SCALVS.ai: agent usage metrics, workflow patterns */
export class ScalusCollector extends ProductCollector {
  product: ProductId = "scalus";
  collect(cid: string) {
    return listDataset(this.dx, {
      cid,
      product: this.product,
      title: "SCALVS agent activity aggregates",
      description: "Anonymized success rates and tool usage from AI workforce agents",
      schema: "agentType,taskCount,successRate,avgTokens",
      sizeEstimate: 100_000,
      privacyLevel: "aggregated",
      licenseTerms: "CDAT-commercial-1y",
      priceUsd: 150,
      scopes: ["usage_metrics", "workflow_stats"],
    });
  }
}

/** Cumulus://Cloud: storage usage, file type distributions (not content) */
export class CumulusCollector extends ProductCollector {
  product: ProductId = "cumulus";
  collect(cid: string) {
    return listDataset(this.dx, {
      cid,
      product: this.product,
      title: "Cumulus storage & compute usage",
      description: "Aggregated storage categories and compute hours (no file contents)",
      schema: "category,gbStored,computeHours",
      sizeEstimate: 20_000,
      privacyLevel: "aggregated",
      licenseTerms: "CDAT-research-1y",
      priceUsd: 80,
      scopes: ["usage_metrics"],
    });
  }
}

/** +SPCTR Spectre: anonymized CRM insights (opt-in accounts only) */
export class SpectreCollector extends ProductCollector {
  product: ProductId = "spectre";
  collect(cid: string) {
    return listDataset(this.dx, {
      cid,
      product: this.product,
      title: "Anonymized pipeline patterns",
      description: "Industry-level deal velocity and win rates (no company names)",
      schema: "industry,avgDealSize,winRate,cycleDays",
      sizeEstimate: 30_000,
      privacyLevel: "aggregated",
      licenseTerms: "CDAT-commercial-1y",
      priceUsd: 400,
      scopes: ["anonymized_insights"],
    });
  }
}

/** :\ARCHITECT\ Architect: workflow execution patterns */
export class ArchitectCollector extends ProductCollector {
  product: ProductId = "architect";
  collect(cid: string) {
    return listDataset(this.dx, {
      cid,
      product: this.product,
      title: "Architect workflow aggregates",
      description: "Anonymized intent-to-completion rates and tool usage",
      schema: "intentType,completionRate,avgSteps",
      sizeEstimate: 40_000,
      privacyLevel: "aggregated",
      licenseTerms: "CDAT-commercial-1y",
      priceUsd: 120,
      scopes: ["usage_metrics"],
    });
  }
}

/** METATRON: prediction / analytics aggregates */
export class MetatronCollector extends ProductCollector {
  product: ProductId = "metatron";
  collect(cid: string) {
    return listDataset(this.dx, {
      cid,
      product: this.product,
      title: "METATRON forecast accuracy aggregates",
      description: "Aggregated prediction confidence and outcome distributions",
      schema: "domain,avgConfidence,outcomeMatchRate",
      sizeEstimate: 25_000,
      privacyLevel: "aggregated",
      licenseTerms: "CDAT-research-1y",
      priceUsd: 200,
      scopes: ["analytics"],
    });
  }
}

/** VEIL</>: anonymized browsing / sidebar usage (no URLs or content) */
export class VeilCollector extends ProductCollector {
  product: ProductId = "veil";
  collect(cid: string) {
    return listDataset(this.dx, {
      cid,
      product: this.product,
      title: "VEIL usage aggregates",
      description: "Anonymized feature usage and session lengths (no browsing history)",
      schema: "feature,sessionCount,avgDuration",
      sizeEstimate: 15_000,
      privacyLevel: "aggregated",
      licenseTerms: "CDAT-research-1y",
      priceUsd: 60,
      scopes: ["usage_metrics"],
    });
  }
}

/** FABRIC: encrypted messaging volume (no message content) */
export class FabricCollector extends ProductCollector {
  product: ProductId = "fabric";
  collect(cid: string) {
    return listDataset(this.dx, {
      cid,
      product: this.product,
      title: "FABRIC messaging volume aggregates",
      description: "Aggregated message counts and session durations (content never included)",
      schema: "msgCount,avgSessionLength,encryptionOverhead",
      sizeEstimate: 10_000,
      privacyLevel: "aggregated",
      licenseTerms: "CDAT-commercial-1y",
      priceUsd: 90,
      scopes: ["usage_metrics"],
    });
  }
}

/** ÆTHER: mesh / connectivity usage aggregates */
export class AetherCollector extends ProductCollector {
  product: ProductId = "aether";
  collect(cid: string) {
    return listDataset(this.dx, {
      cid,
      product: this.product,
      title: "ÆTHER connectivity aggregates",
      description: "Aggregated mesh hop counts and uptime stats (no location or traffic content)",
      schema: "hopCount,uptimeHours,tier",
      sizeEstimate: 12_000,
      privacyLevel: "aggregated",
      licenseTerms: "CDAT-research-1y",
      priceUsd: 70,
      scopes: ["usage_metrics"],
    });
  }
}

/** HRVST: harvest packet stats after privacy filter */
export class HrvstCollector extends ProductCollector {
  product: ProductId = "hrvst";
  collect(cid: string) {
    return listDataset(this.dx, {
      cid,
      product: this.product,
      title: "HRVST filtered packet aggregates",
      description: "Counts of privacy-filtered harvest packets by media type (no raw media)",
      schema: "mediaType,packetCount,filterRate",
      sizeEstimate: 18_000,
      privacyLevel: "aggregated",
      licenseTerms: "CDAT-commercial-1y",
      priceUsd: 110,
      scopes: ["usage_metrics"],
    });
  }
}

/** ei·det·ic: restricted identity-intelligence aggregates (authorized use only) */
export class EideticCollector extends ProductCollector {
  product: ProductId = "eidetic";
  collect(cid: string) {
    // Restricted — only when explicitly authorized and non-military
    return listDataset(this.dx, {
      cid,
      product: this.product,
      title: "Eidetic authorized aggregates",
      description: "High-level authorized query volume only (restricted product)",
      schema: "queryType,count",
      sizeEstimate: 5_000,
      privacyLevel: "aggregated",
      licenseTerms: "CDAT-restricted-1y",
      priceUsd: 300,
      scopes: ["authorized_metrics"],
    });
  }
}

/** FIRM Wallet / token activity aggregates */
export class FirmCollector extends ProductCollector {
  product: ProductId = "firm";
  collect(cid: string) {
    return listDataset(this.dx, {
      cid,
      product: this.product,
      title: "FIRM Wallet activity aggregates",
      description: "Aggregated swap and transfer counts (no balances or addresses)",
      schema: "actionType,count,avgSizeBucket",
      sizeEstimate: 8_000,
      privacyLevel: "aggregated",
      licenseTerms: "CDAT-research-1y",
      priceUsd: 50,
      scopes: ["usage_metrics"],
    });
  }
}

/** Firmament Network: public ledger stats only */
export class FirmamentCollector extends ProductCollector {
  product: ProductId = "firmament";
  collect(cid: string) {
    return listDataset(this.dx, {
      cid,
      product: this.product,
      title: "Firmament ledger activity aggregates",
      description: "Aggregated record type counts (public ledger stats)",
      schema: "recordType,count",
      sizeEstimate: 4_000,
      privacyLevel: "aggregated",
      licenseTerms: "CDAT-research-1y",
      priceUsd: 40,
      scopes: ["public_stats"],
    });
  }
}

/** Project-specific tokens activity */
export class TokensCollector extends ProductCollector {
  product: ProductId = "tokens";
  collect(cid: string) {
    return listDataset(this.dx, {
      cid,
      product: this.product,
      title: "Product token activity aggregates",
      description: "Aggregated reward and transfer counts by product token",
      schema: "tokenSymbol,actionCount",
      sizeEstimate: 6_000,
      privacyLevel: "aggregated",
      licenseTerms: "CDAT-research-1y",
      priceUsd: 45,
      scopes: ["usage_metrics"],
    });
  }
}

/** E(O)N wearable: limited usage aggregates (no audio/spectrum content) */
export class EonCollector extends ProductCollector {
  product: ProductId = "eon";
  collect(cid: string) {
    return listDataset(this.dx, {
      cid,
      product: this.product,
      title: "E(O)N wearable usage aggregates",
      description: "Aggregated session counts and battery/uptime (no sensor content)",
      schema: "sessionCount,avgDuration",
      sizeEstimate: 7_000,
      privacyLevel: "aggregated",
      licenseTerms: "CDAT-research-1y",
      priceUsd: 55,
      scopes: ["usage_metrics"],
    });
  }
}

/** Factory for all product collectors (software products only) */
export function createCollectors(dx: DataExchange): ProductCollector[] {
  return [
    new ScalusCollector(dx),
    new CumulusCollector(dx),
    new SpectreCollector(dx),
    new ArchitectCollector(dx),
    new MetatronCollector(dx),
    new VeilCollector(dx),
    new FabricCollector(dx),
    new AetherCollector(dx),
    new HrvstCollector(dx),
    new EideticCollector(dx),
    new FirmCollector(dx),
    new FirmamentCollector(dx),
    new TokensCollector(dx),
    new EonCollector(dx),
  ];
}
