// © Infinitum Corporation®. All rights reserved.
/**
 * Dataset catalog, modelled on LinkedIn DataHub's metadata model: each dataset has owners,
 * a classification, allowed purposes, a glossary of business terms, upstream lineage, the
 * transformation version that produced it, its latest quality report and its expiry.
 * Cumulus Exchange may only list datasets the catalog marks exportable.
 */
import type { Classification, Purpose } from "./envelope.ts";
import type { QualityReport } from "./quality.ts";

export interface Dataset {
  id: string;
  zone: "raw" | "normalized" | "curated";
  table: string;
  description: string;
  owners: string[];
  classification: Classification;
  purposes: Purpose[];
  glossary: Record<string, string>;
  upstream: string[];
  transformation_version: string;
  expires_after_days: number | null;
  exportable: boolean;
  quality?: QualityReport;
  deletions: { object_id: string; at: string; rows: number }[];
}

export class Catalog {
  private datasets = new Map<string, Dataset>();

  register(d: Omit<Dataset, "deletions" | "quality">): Dataset {
    for (const up of d.upstream) if (!this.datasets.has(up)) throw new Error(`unknown upstream dataset ${up}`);
    const full: Dataset = { ...d, deletions: [] };
    this.datasets.set(d.id, full);
    return full;
  }

  get(id: string): Dataset | undefined {
    return this.datasets.get(id);
  }

  list(): Dataset[] {
    return [...this.datasets.values()];
  }

  recordQuality(id: string, report: QualityReport): void {
    const d = this.datasets.get(id);
    if (d) d.quality = report;
  }

  recordDeletion(id: string, objectId: string, rows: number, at = new Date()): void {
    const d = this.datasets.get(id);
    if (d) d.deletions.push({ object_id: objectId, at: at.toISOString(), rows });
  }

  /** Every dataset this one is derived from, nearest first. */
  lineage(id: string): string[] {
    const out: string[] = [];
    const walk = (x: string) => {
      for (const up of this.datasets.get(x)?.upstream ?? []) {
        if (!out.includes(up)) {
          out.push(up);
          walk(up);
        }
      }
    };
    walk(id);
    return out;
  }

  /** Every dataset derived from this one, so a deletion knows where to propagate. */
  downstream(id: string): string[] {
    const out: string[] = [];
    const walk = (x: string) => {
      for (const d of this.datasets.values()) {
        if (d.upstream.includes(x) && !out.includes(d.id)) {
          out.push(d.id);
          walk(d.id);
        }
      }
    };
    walk(id);
    return out;
  }

  search(q: string): Dataset[] {
    const t = q.toLowerCase();
    return this.list().filter(
      (d) =>
        d.id.includes(t) ||
        d.description.toLowerCase().includes(t) ||
        Object.entries(d.glossary).some(([k, v]) => k.toLowerCase().includes(t) || v.toLowerCase().includes(t)),
    );
  }
}

export const TRANSFORMATION_VERSION = "normalize@1.0.0";

export function defaultCatalog(): Catalog {
  const c = new Catalog();
  c.register({
    id: "raw.events",
    zone: "raw",
    table: "raw/events",
    description: "Verified event envelopes as accepted by the collection gateway.",
    owners: ["data-platform"],
    classification: "confidential",
    purposes: ["service_operation", "security"],
    glossary: { envelope: "The common event format every product sends.", subject_id: "Tenant-scoped pseudonym of a Cumulus ID." },
    upstream: [],
    transformation_version: "gateway@1.0.0",
    expires_after_days: 365,
    exportable: false,
  });
  c.register({
    id: "normalized.events",
    zone: "normalized",
    table: "normalized/events",
    description: "One typed row per accepted event.",
    owners: ["data-platform"],
    classification: "confidential",
    purposes: ["service_operation", "security", "product_analytics", "billing"],
    glossary: {},
    upstream: ["raw.events"],
    transformation_version: TRANSFORMATION_VERSION,
    expires_after_days: 365,
    exportable: false,
  });
  c.register({
    id: "curated.files",
    zone: "curated",
    table: "curated/files",
    description: "Current state of every Cumulus://Cloud file: size, type, version, owner and readers.",
    owners: ["cumulus-cloud", "data-platform"],
    classification: "confidential",
    purposes: ["service_operation", "product_analytics", "billing"],
    glossary: { file: "A Cumulus://Cloud file; its content never enters the platform, only metadata." },
    upstream: ["normalized.events"],
    transformation_version: "curate-files@1.0.0",
    expires_after_days: null,
    exportable: false,
  });
  return c;
}
