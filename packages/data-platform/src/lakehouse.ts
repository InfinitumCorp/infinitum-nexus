// © Infinitum Corporation®. All rights reserved.
/**
 * The lakehouse: three zones of snapshot tables over one object store.
 *
 *   raw         verified envelopes exactly as the gateway accepted them (append only,
 *               deduplicated by tenant + event_id, purged by retention or deletion)
 *   normalized  one typed row per event with transformation version and lineage
 *   curated     current-state tables built for the ontology and analytics
 *
 * Inserts, corrections and deletions are applied incrementally per object, the way
 * Apache Hudi does upserts, but deletes here are purges that also expire history.
 */
import { createHash } from "node:crypto";
import type { Envelope } from "./envelope.ts";
import { isConditional, PreconditionFailed, type ObjectStore } from "./storage.ts";
import { Table, type Row } from "./table.ts";

export interface RawRow extends Row {
  envelope: Envelope;
  retention_until: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A claim older than this whose event never reached the raw zone may be taken over. */
export const STALE_CLAIM_MS = 10 * 60_000;

export function dedupeKey(tenantId: string, eventId: string): string {
  const h = createHash("sha256").update(`${tenantId}\u0000${eventId}`).digest("hex");
  return `dedupe/${h.slice(0, 2)}/${h}`;
}

export function partitionOf(row: Row): string {
  const product = String(row.product ?? (row.envelope as Envelope | undefined)?.product ?? "unknown");
  const at = String(row.occurred_at ?? (row.envelope as Envelope | undefined)?.occurred_at ?? "1970-01-01");
  return `product=${product}/date=${at.slice(0, 10)}`;
}

export class Lakehouse {
  readonly store: ObjectStore;
  readonly raw: Table;
  readonly normalized: Table;
  readonly curatedFiles: Table;
  private lock: Promise<unknown> = Promise.resolve();

  constructor(store: ObjectStore) {
    this.store = store;
    this.raw = new Table(store, "raw/events");
    this.normalized = new Table(store, "normalized/events");
    this.curatedFiles = new Table(store, "curated/files");
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  /**
   * Writes envelopes to the raw zone exactly once. Returns the envelopes that were new;
   * replays of an already stored (tenant, event_id) are dropped.
   */
  appendRaw(items: { envelope: Envelope; retentionDays: number }[]): Promise<{ added: Envelope[]; duplicates: string[] }> {
    return this.exclusive(async () => {
      const added: Envelope[] = [];
      const duplicates: string[] = [];
      const rows: RawRow[] = [];
      const seen = new Set<string>();
      const claimed: string[] = [];
      for (const { envelope, retentionDays } of items) {
        const key = dedupeKey(envelope.tenant_id, envelope.event_id);
        if (seen.has(key) || !(await this.claim(key, envelope))) {
          duplicates.push(envelope.event_id);
          continue;
        }
        seen.add(key);
        claimed.push(key);
        const until = new Date(Date.parse(envelope.received_at) + retentionDays * 86_400_000).toISOString();
        rows.push({ envelope, retention_until: until });
        added.push(envelope);
      }
      if (rows.length) {
        try {
          await this.raw.append(rows, partitionOf);
        } catch (e) {
          // Release the claims so a retry can store these events.
          for (const k of claimed) await this.store.delete(k).catch(() => undefined);
          throw e;
        }
        // Turn each claim into a committed marker that records the retention date.
        for (const r of rows) {
          await this.store.put(dedupeKey(r.envelope.tenant_id, r.envelope.event_id), enc.encode(r.retention_until));
        }
      }
      return { added, duplicates };
    });
  }

  /**
   * Claims an event id before its raw write. On a conditional store (R2, S3) the claim is an
   * atomic create, so two gateway processes can never both store the same event. A claim
   * left behind by a crashed writer is taken over once it is stale and the event is
   * confirmed missing from the raw zone, so a crash never loses an event either.
   */
  private async claim(key: string, e: Envelope): Promise<boolean> {
    const pending = enc.encode(`pending:${new Date().toISOString()}`);
    if (!isConditional(this.store)) {
      if (await this.store.get(key)) return false;
      await this.store.put(key, pending);
      return true;
    }
    try {
      await this.store.putIf(key, pending, null);
      return true;
    } catch (err) {
      if (!(err instanceof PreconditionFailed)) throw err;
    }
    const cur = await this.store.getWithEtag(key);
    if (!cur) return this.claim(key, e);
    const v = dec.decode(cur.bytes);
    if (!v.startsWith("pending:") || Date.now() - Date.parse(v.slice(8)) < STALE_CLAIM_MS) return false;
    const stored = await this.raw.scan((r) => (r as RawRow).envelope.tenant_id === e.tenant_id && (r as RawRow).envelope.event_id === e.event_id);
    if (stored.length) return false;
    try {
      await this.store.putIf(key, pending, cur.etag);
      return true;
    } catch (err) {
      if (err instanceof PreconditionFailed) return false;
      throw err;
    }
  }

  async rawEvents(filter?: (e: Envelope) => boolean): Promise<Envelope[]> {
    const rows = await this.raw.scan();
    return rows.map((r) => (r as RawRow).envelope).filter((e) => !filter || filter(e));
  }

  /**
   * Removes everything derived from one object in every zone. The raw zone keeps only the
   * deletion event itself (as the audit tombstone) and drops the earlier events, whose
   * payloads describe the deleted content.
   */
  async purgeObject(tenantId: string, objectId: string, keepEventId: string): Promise<{ raw: number; normalized: number; curated: number }> {
    const raw = await this.raw.deleteWhere((r) => {
      const e = (r as RawRow).envelope;
      return e.tenant_id === tenantId && e.object_id === objectId && e.event_id !== keepEventId;
    }, `object deleted: ${objectId}`);
    const normalized = await this.normalized.deleteWhere(
      (r) => r.tenant_id === tenantId && r.object_id === objectId && r.event_id !== keepEventId,
      `object deleted: ${objectId}`,
    );
    const curated = await this.curatedFiles.deleteWhere((r) => r.tenant_id === tenantId && r.file_id === objectId, `object deleted: ${objectId}`);
    return { raw, normalized, curated };
  }

  /** Drops raw and normalized rows past their retention date. */
  async purgeExpired(now: Date = new Date()): Promise<{ raw: number; normalized: number }> {
    const t = now.toISOString();
    const raw = await this.raw.deleteWhere((r) => String(r.retention_until) <= t, "retention");
    const normalized = await this.normalized.deleteWhere((r) => String(r.retention_until) <= t, "retention");
    // Dedupe markers expire with their events; after that an event id may be reused.
    for (const k of await this.store.list("dedupe/")) {
      const v = await this.store.get(k);
      const s = v ? dec.decode(v) : "";
      if (!s.startsWith("pending:") && s <= t) await this.store.delete(k);
    }
    return { raw, normalized };
  }
}
