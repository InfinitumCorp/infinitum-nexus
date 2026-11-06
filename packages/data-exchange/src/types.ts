/**
 * Core types for Cumulus Data Exchange.
 * All data is opt-in, consent-recorded on Firmament, and private by default.
 */
export type ProductId = 
  | "cumulus" 
  | "scalus" 
  | "spectre" 
  | "architect" 
  /** Former name of architect; older listings may still carry it. */
  | "conductor" 
  | "veil" 
  | "fabric" 
  | "aether" 
  | "metatron" 
  | "hrvst" 
  | "eidetic" 
  | "firm" 
  | "firmament" 
  | "tokens" 
  | "eon" 
  | "other";

export interface ConsentRecord {
  id: string;
  cid: string; // Cumulus://ID
  product: ProductId;
  datasetId: string;
  granted: boolean;
  scopes: string[]; // e.g. ["usage_metrics", "anonymized_content"]
  purpose: string; // e.g. "licensing_to_brokers"
  timestamp: string;
  firmamentTx?: string; // hash or tx id on Firmament Network
}

export interface Dataset {
  id: string;
  ownerCid: string;
  product: ProductId;
  title: string;
  description: string;
  schema: string; // JSON schema or description
  sizeEstimate: number; // bytes or records
  privacyLevel: "anonymized" | "pseudonymized" | "aggregated";
  licenseTerms: string; // e.g. "CDAT-commercial-1y"
  priceUsd: number; // suggested or fixed
  revSharePct: number; // default 85 to user
  status: "draft" | "listed" | "sold" | "revoked";
  createdAt: string;
  consentId?: string;
}

export interface LicenseSale {
  id: string;
  datasetId: string;
  buyerId: string; // data broker or buyer CID
  amountUsd: number;
  userShareUsd: number;
  platformShareUsd: number;
  cdatTokenId?: string; // CDAT license token on Firmament / Base
  soldAt: string;
  status: "pending" | "completed" | "refunded";
}

export interface DataBroker {
  id: string;
  name: string;
  contact: string;
  verified: boolean;
  allowedCategories: string[];
}
