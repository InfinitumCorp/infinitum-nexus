// © Infinitum Corporation®. All rights reserved.
/**
 * Preparing a curated dataset for Cumulus Exchange. Only aggregates leave the platform:
 * each offer is a set of differentially private counts, never rows. An offer is refused
 * unless every gate passes:
 *
 *   - the catalog marks the dataset exportable, not restricted, with exchange_licensing
 *   - its latest quality report (if any) passed
 *   - every contributing tenant's policy record allows export for exchange_licensing
 *   - the product is not a military/defense product
 *   - the privacy budget for the dataset still has room
 *
 * The result maps onto @infinitum/data-exchange's Dataset (privacyLevel "aggregated").
 */
import type { Catalog } from "./catalog.ts";
import type { PolicyService } from "./policy.ts";
import { dpCountDistinct, type PrivacyBudget } from "./privacy.ts";
import { EXCLUDED_PRODUCTS } from "./schemas.ts";
import type { Row } from "./table.ts";

export interface ExchangeOffer {
  dataset_id: string;
  product: string;
  title: string;
  description: string;
  privacyLevel: "aggregated";
  schema: string;
  /** Noisy distinct-person counts per group; small groups suppressed. */
  counts: Record<string, number>;
  epsilon: number;
  tenants: number;
  licenseTerms: string;
  priceUsd: number;
  generated_at: string;
  lineage: string[];
}

export class ExportRefused extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(`export refused: ${reasons.join("; ")}`);
    this.name = "ExportRefused";
    this.reasons = reasons;
  }
}

export interface OfferInput {
  catalog: Catalog;
  policy: PolicyService;
  budget: PrivacyBudget;
  datasetId: string;
  product: string;
  title: string;
  rows: Row[];
  /** Column holding the tenant, used to check each contributing tenant's policy. */
  tenantColumn: string;
  /** Column holding the pseudonymous person id, used to bound contributions. */
  personColumn: string;
  groupColumn: string;
  /** Publish only these groups (avoids leaking which groups exist). */
  groups?: string[];
  epsilon: number;
  licenseTerms: string;
  priceUsd: number;
  threshold?: number;
  /** Noise source passed to dpCountDistinct; defaults to CSPRNG Laplace noise. Tests inject a fixed value. */
  noise?: (scale: number) => number;
}

export function prepareOffer(i: OfferInput): ExchangeOffer {
  const reasons: string[] = [];
  const d = i.catalog.get(i.datasetId);
  if (!d) throw new ExportRefused([`unknown dataset ${i.datasetId}`]);
  if (EXCLUDED_PRODUCTS.has(i.product)) reasons.push("military and defense products are excluded");
  if (!d.exportable) reasons.push("dataset is not marked exportable");
  if (d.classification === "restricted") reasons.push("restricted datasets are never exported");
  if (!d.purposes.includes("exchange_licensing")) reasons.push("dataset purposes do not include exchange_licensing");
  if (d.quality && !d.quality.ok) reasons.push("latest quality report failed");
  const tenants = new Set(i.rows.map((r) => String(r[i.tenantColumn])));
  for (const t of tenants) {
    const p = i.policy.get(t, i.product);
    if (!p || !p.exportAllowed || !p.purposes.includes("exchange_licensing")) {
      reasons.push(`tenant ${t} has not allowed export`);
    }
  }
  if (reasons.length) throw new ExportRefused(reasons);

  const counts = dpCountDistinct(i.rows, {
    dataset: i.datasetId,
    budget: i.budget,
    epsilon: i.epsilon,
    person: (r) => String(r[i.personColumn]),
    group: (r) => String(r[i.groupColumn]),
    ...(i.groups ? { groups: i.groups } : {}),
    ...(i.threshold !== undefined ? { threshold: i.threshold } : {}),
    ...(i.noise ? { noise: i.noise } : {}),
  });
  return {
    dataset_id: d.id,
    product: i.product,
    title: i.title,
    description: d.description,
    privacyLevel: "aggregated",
    schema: JSON.stringify({ group: i.groupColumn, value: "noisy distinct people" }),
    counts: Object.fromEntries(counts),
    epsilon: i.epsilon,
    tenants: tenants.size,
    licenseTerms: i.licenseTerms,
    priceUsd: i.priceUsd,
    generated_at: new Date().toISOString(),
    lineage: [d.id, ...i.catalog.lineage(d.id)],
  };
}
