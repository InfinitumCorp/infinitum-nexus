// © Infinitum Corporation®. All rights reserved.
/**
 * Postgres persistence for the authoritative records and the ontology serving copy, over
 * the tables in migrations/0001_ontology_policy.sql. No driver dependency: pass any
 * `pg`-compatible client (`query(text, params)`), the same shape @infinitum/cid uses.
 * Transactions need a single connection (a pool client or a request scope), not a pool.
 */
import type { OntologyChange } from "./ontology.ts";
import type { PolicyRecord, PolicyService, Pseudonymizer } from "./policy.ts";
import type { Purpose } from "./envelope.ts";

export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

/**
 * Opt-in keys that never contain a raw Cumulus ID: an HMAC pseudonym scoped to the product.
 * Pass this as PolicyService's `optInKey` when opt-ins are persisted.
 */
export function optInKeyFor(p: Pseudonymizer): (product: string, cid: string) => string {
  return (product, cid) => `${product}:${p.subject(`optin:${product}`, cid)}`;
}

export class PgPolicyRepository {
  private readonly db: Queryable;
  constructor(db: Queryable) {
    this.db = db;
  }

  /** Loads every policy record and opt-in into the service (call at startup and on a timer). */
  async load(policy: PolicyService): Promise<{ records: number; optIns: number }> {
    const r = await this.db.query(
      "-- policy.list\nSELECT id, tenant_id, product, purposes, retention_days, export_allowed, source_rights FROM policy_records",
    );
    for (const row of r.rows) policy.put(rowToRecord(row));
    const o = await this.db.query("-- optin.list\nSELECT product, subject_id FROM opt_ins");
    policy.loadOptInKeys(o.rows.map((x) => `${String(x.product)}:${String(x.subject_id)}`));
    return { records: r.rows.length, optIns: o.rows.length };
  }

  async save(policy: PolicyService, rec: PolicyRecord): Promise<void> {
    policy.put(rec); // validates exclusions and contracts before anything is written
    await this.db.query(
      `-- policy.upsert
INSERT INTO policy_records (id, tenant_id, product, purposes, retention_days, export_allowed, source_rights)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (tenant_id, product) DO UPDATE SET id = EXCLUDED.id, purposes = EXCLUDED.purposes,
  retention_days = EXCLUDED.retention_days, export_allowed = EXCLUDED.export_allowed,
  source_rights = EXCLUDED.source_rights, updated_at = now()`,
      [rec.id, rec.tenant_id, rec.product, rec.purposes, rec.retentionDays ?? null, rec.exportAllowed, rec.sourceRights],
    );
  }

  async optIn(policy: PolicyService, product: string, cid: string): Promise<void> {
    const key = policy.optInKey(product, cid);
    const subject = key.slice(product.length + 1);
    if (!key.startsWith(`${product}:`) || !/^sub_[0-9a-f]{32}$/.test(subject)) {
      throw new Error("persisting opt-ins needs PolicyService({ optInKey: optInKeyFor(pseudonymizer) })");
    }
    await this.db.query("-- optin.insert\nINSERT INTO opt_ins (product, subject_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [product, subject]);
    policy.optIn(product, cid);
  }

  async optOut(policy: PolicyService, product: string, cid: string): Promise<void> {
    const subject = policy.optInKey(product, cid).slice(product.length + 1);
    policy.optOut(product, cid); // stop collection first, even if the write below fails
    await this.db.query("-- optin.delete\nDELETE FROM opt_ins WHERE product = $1 AND subject_id = $2", [product, subject]);
  }
}

function rowToRecord(row: Record<string, unknown>): PolicyRecord {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    product: String(row.product),
    purposes: (row.purposes as string[]).map((p) => p as Purpose),
    ...(row.retention_days == null ? {} : { retentionDays: Number(row.retention_days) }),
    exportAllowed: Boolean(row.export_allowed),
    sourceRights: String(row.source_rights),
  };
}

/** Applies ontology changes to Postgres in one transaction, including deletions and links. */
export class PgOntologyMirror {
  private readonly db: Queryable;
  constructor(db: Queryable) {
    this.db = db;
  }

  async apply(changes: OntologyChange[]): Promise<void> {
    if (!changes.length) return;
    await this.db.query("BEGIN");
    try {
      for (const c of changes) {
        switch (c.op) {
          case "upsert": {
            const o = c.object;
            await this.db.query(
              `-- object.upsert
INSERT INTO ontology_objects (tenant_id, type, id, owner, readers, classification, properties, source_events, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (tenant_id, type, id) DO UPDATE SET owner = EXCLUDED.owner, readers = EXCLUDED.readers,
  classification = EXCLUDED.classification, properties = EXCLUDED.properties,
  source_events = EXCLUDED.source_events, updated_at = EXCLUDED.updated_at`,
              [o.tenant_id, o.type, o.id, o.owner, o.readers, o.classification, JSON.stringify(o.properties), o.source_events, o.updated_at],
            );
            break;
          }
          case "delete":
            await this.db.query("-- object.delete\nDELETE FROM ontology_objects WHERE tenant_id = $1 AND type = $2 AND id = $3", [c.tenant_id, c.type, c.id]);
            await this.db.query(
              "-- link.delete_touching\nDELETE FROM ontology_links WHERE tenant_id = $1 AND (from_ref = $2 OR to_ref = $2)",
              [c.tenant_id, `${c.type}:${c.id}`],
            );
            await this.db.query(
              `-- deletion.log
INSERT INTO deletion_log (tenant_id, object_id, event_id, dataset, rows) VALUES ($1, $2, '', 'ontology', 1)
ON CONFLICT (tenant_id, object_id, dataset) DO UPDATE SET deleted_at = now()`,
              [c.tenant_id, c.id],
            );
            break;
          case "link":
            await this.db.query(
              "-- link.insert\nINSERT INTO ontology_links (tenant_id, type, from_ref, to_ref) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
              [c.link.tenant_id, c.link.type, c.link.from, c.link.to],
            );
            break;
          case "unlink":
            await this.db.query(
              "-- link.delete\nDELETE FROM ontology_links WHERE tenant_id = $1 AND type = $2 AND from_ref = $3 AND to_ref = $4",
              [c.link.tenant_id, c.link.type, c.link.from, c.link.to],
            );
            break;
        }
      }
      await this.db.query("COMMIT");
    } catch (e) {
      await this.db.query("ROLLBACK").catch(() => undefined);
      throw e;
    }
  }
}
