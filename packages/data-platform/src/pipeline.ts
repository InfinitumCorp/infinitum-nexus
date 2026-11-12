// © Infinitum Corporation®. All rights reserved.
/**
 * Pipeline from raw to normalized to curated to the ontology.
 *
 * Normalization is idempotent: an event already present in the normalized zone is skipped,
 * so replaying the raw zone (or a crash between the raw commit and the dedupe markers)
 * never double-counts. `file.deleted` propagates to every zone, the ontology and its search
 * index, and is recorded on every affected catalog dataset.
 */
import type { Envelope } from "./envelope.ts";
import type { Catalog } from "./catalog.ts";
import { TRANSFORMATION_VERSION } from "./catalog.ts";
import { partitionOf, type Lakehouse, type RawRow } from "./lakehouse.ts";
import type { Ontology, OntologyChange, OntologyObject } from "./ontology.ts";
import { runChecks, type Check } from "./quality.ts";
import type { Row } from "./table.ts";

export const CURATED_FILE_CHECKS: Check[] = [
  { kind: "completeness", column: "file_id", min: 1 },
  { kind: "completeness", column: "owner", min: 1 },
  { kind: "uniqueness", columns: ["tenant_id", "file_id"] },
  { kind: "range", column: "size_bytes", min: 0, max: 1e13 },
];

export interface PipelineStats {
  normalized: number;
  skipped: number;
  objects_upserted: number;
  objects_deleted: number;
}

export class Pipeline {
  readonly lakehouse: Lakehouse;
  readonly ontology: Ontology;
  readonly catalog: Catalog;
  /** Optional serving copy that follows every ontology change (e.g. PgOntologyMirror). */
  mirror?: { apply(changes: OntologyChange[]): Promise<void> };

  constructor(lakehouse: Lakehouse, ontology: Ontology, catalog: Catalog) {
    this.lakehouse = lakehouse;
    this.ontology = ontology;
    this.catalog = catalog;
  }

  private normalize(e: Envelope, retentionUntil: string): Row {
    return {
      event_id: e.event_id,
      tenant_id: e.tenant_id,
      product: e.product,
      event_type: e.event_type,
      occurred_at: e.occurred_at,
      received_at: e.received_at,
      subject_id: e.subject_id,
      object_id: e.object_id,
      purpose: e.purpose,
      classification: e.classification,
      policy_ref: e.policy_ref,
      ...Object.fromEntries(Object.entries(e.payload).map(([k, v]) => [`p_${k}`, v])),
      retention_until: retentionUntil,
      transformation_version: TRANSFORMATION_VERSION,
      lineage: `raw.events:${e.event_id}`,
    };
  }

  /** Processes newly accepted envelopes (called by the gateway, or by `replay`). */
  async process(envelopes: Envelope[]): Promise<PipelineStats> {
    const stats: PipelineStats = { normalized: 0, skipped: 0, objects_upserted: 0, objects_deleted: 0 };
    if (!envelopes.length) return stats;
    const ids = new Set(envelopes.map((e) => `${e.tenant_id}\u0000${e.event_id}`));
    const already = new Set(
      (await this.lakehouse.normalized.scan((r) => ids.has(`${r.tenant_id}\u0000${r.event_id}`))).map((r) => `${r.tenant_id}\u0000${r.event_id}`),
    );
    const rawRows = await this.lakehouse.raw.scan((r) => ids.has(`${(r as RawRow).envelope.tenant_id}\u0000${(r as RawRow).envelope.event_id}`));
    const retention = new Map(rawRows.map((r) => [`${(r as RawRow).envelope.tenant_id}\u0000${(r as RawRow).envelope.event_id}`, String(r.retention_until)]));

    const fresh: Envelope[] = [];
    for (const e of envelopes) {
      const k = `${e.tenant_id}\u0000${e.event_id}`;
      if (already.has(k) || !retention.has(k)) stats.skipped++;
      else fresh.push(e);
    }
    fresh.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
    if (fresh.length) {
      await this.lakehouse.normalized.append(
        fresh.map((e) => this.normalize(e, retention.get(`${e.tenant_id}\u0000${e.event_id}`)!)),
        partitionOf,
      );
      stats.normalized = fresh.length;
    }

    const touchedTenants = new Set<string>();
    for (const e of fresh) {
      if (e.product === "cumulus-cloud" && e.object_id) {
        const r = await this.applyFileEvent(e);
        stats.objects_upserted += r.upserted;
        stats.objects_deleted += r.deleted;
        touchedTenants.add(e.tenant_id);
      } else if (e.object_id && e.event_type.endsWith(".deleted")) {
        // Any product's deletion purges that object from every zone.
        const purged = await this.lakehouse.purgeObject(e.tenant_id, e.object_id, e.event_id);
        this.catalog.recordDeletion("raw.events", e.object_id, purged.raw);
        this.catalog.recordDeletion("normalized.events", e.object_id, purged.normalized);
        stats.objects_deleted++;
      } else if (e.product === "cumulus-id" && e.subject_id) {
        this.ontology.upsert(this.account(e));
        stats.objects_upserted++;
      }
    }
    if (touchedTenants.size) await this.rebuildCuratedFiles();
    const changes = this.ontology.drainChanges();
    if (this.mirror && changes.length) await this.mirror.apply(changes);
    return stats;
  }

  private account(e: Envelope): OntologyObject {
    return {
      type: "Account",
      id: e.subject_id!,
      tenant_id: e.tenant_id,
      readers: [e.subject_id!],
      owner: e.subject_id,
      classification: "confidential",
      properties: {},
      source_events: [e.event_id],
      updated_at: e.occurred_at,
    };
  }

  private async applyFileEvent(e: Envelope): Promise<{ upserted: number; deleted: number }> {
    const id = e.object_id!;
    const existing = this.ontology.raw("File", id, e.tenant_id);
    switch (e.event_type) {
      case "file.uploaded":
      case "file.version_added": {
        if (existing && existing.owner !== e.subject_id) return { upserted: 0, deleted: 0 }; // only the owner changes a file
        const p = e.payload;
        this.ontology.upsert({
          type: "File",
          id,
          tenant_id: e.tenant_id,
          readers: existing?.readers ?? [],
          owner: existing?.owner ?? e.subject_id,
          classification: e.classification,
          properties: {
            size_bytes: (p.size_bytes as number) ?? null,
            ...(p.media_type !== undefined ? { media_type: p.media_type } : {}),
            version: (p.version as number | undefined) ?? (existing?.properties.version as number | undefined) ?? 1,
            ...(p.folder_id !== undefined ? { folder_id: p.folder_id } : {}),
          },
          source_events: [e.event_id],
          updated_at: e.occurred_at,
        });
        if (e.subject_id) this.ontology.link({ type: "owns", from: `Account:${e.subject_id}`, to: `File:${id}`, tenant_id: e.tenant_id });
        return { upserted: 1, deleted: 0 };
      }
      case "file.shared":
      case "file.unshared": {
        if (!existing || existing.owner !== e.subject_id) return { upserted: 0, deleted: 0 };
        const grantee = String(e.payload.grantee_cid);
        const readers = new Set(existing.readers);
        if (e.event_type === "file.shared") {
          readers.add(grantee);
          this.ontology.link({ type: "shared_with", from: `File:${id}`, to: `Account:${grantee}`, tenant_id: e.tenant_id });
        } else {
          readers.delete(grantee);
          this.ontology.unlink((l) => l.type === "shared_with" && l.from === `File:${id}` && l.to === `Account:${grantee}`);
        }
        if (existing.owner) readers.add(existing.owner);
        this.ontology.upsert({ ...existing, readers: [...readers], source_events: [e.event_id], updated_at: e.occurred_at });
        return { upserted: 1, deleted: 0 };
      }
      case "file.deleted": {
        if (existing && existing.owner !== e.subject_id) return { upserted: 0, deleted: 0 };
        this.ontology.delete("File", id, e.tenant_id);
        const purged = await this.lakehouse.purgeObject(e.tenant_id, id, e.event_id);
        this.catalog.recordDeletion("raw.events", id, purged.raw);
        this.catalog.recordDeletion("normalized.events", id, purged.normalized);
        this.catalog.recordDeletion("curated.files", id, purged.curated);
        return { upserted: 0, deleted: 1 };
      }
    }
    return { upserted: 0, deleted: 0 };
  }

  /** Rebuilds curated/files from the ontology and runs its quality checks. */
  async rebuildCuratedFiles(): Promise<void> {
    const tenants = new Set<string>();
    for (const r of await this.lakehouse.normalized.scan((r) => r.product === "cumulus-cloud")) tenants.add(String(r.tenant_id));
    const rows: Row[] = [];
    for (const t of tenants) {
      for (const o of this.ontology.all(t, "File")) {
        rows.push({
          tenant_id: o.tenant_id,
          file_id: o.id,
          owner: o.owner,
          readers: o.readers.length,
          size_bytes: o.properties.size_bytes ?? null,
          media_type: o.properties.media_type ?? null,
          version: o.properties.version ?? null,
          updated_at: o.updated_at,
          product: "cumulus-cloud",
          occurred_at: o.updated_at,
        });
      }
    }
    await this.lakehouse.curatedFiles.overwrite(rows, partitionOf, "rebuild");
    this.catalog.recordQuality("curated.files", runChecks("curated.files", rows, CURATED_FILE_CHECKS));
  }

  /** Rebuilds normalized, curated and the ontology from the raw zone. */
  async replay(): Promise<PipelineStats> {
    return this.process(await this.lakehouse.rawEvents());
  }
}
