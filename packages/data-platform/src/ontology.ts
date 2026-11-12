// © Infinitum Corporation®. All rights reserved.
/**
 * The Infinitum Ontology: typed objects and links built from curated data, with access
 * that follows the source system's permissions. A file object is visible to its owner and
 * to the people it is shared with in the same tenant, nothing else.
 *
 * The search index is a derived index (an inverted index in the style of Elasticsearch,
 * filtered by permission at query time). Deleting an object removes it, its links and its
 * index entries together.
 */
import type { Classification } from "./envelope.ts";

export const OBJECT_TYPES = [
  "Account",
  "Organization",
  "Product",
  "File",
  "Dataset",
  "Event",
  "Workflow",
  "Device",
  "Source",
  "Permission",
  "License",
  "RevenueAllocation",
] as const;
export type ObjectType = (typeof OBJECT_TYPES)[number];

export const LINK_TYPES = ["owns", "shared_with", "member_of", "derived_from", "licensed_by", "produced_by"] as const;
export type LinkType = (typeof LINK_TYPES)[number];

export interface OntologyObject {
  type: ObjectType;
  id: string;
  tenant_id: string;
  /** Pseudonymous subject ids that may read this object. Empty = every tenant member. */
  readers: string[];
  owner: string | null;
  classification: Classification;
  properties: Record<string, string | number | boolean | null>;
  /** Raw event ids this object was built from. */
  source_events: string[];
  updated_at: string;
}

export interface Link {
  type: LinkType;
  from: string;
  to: string;
  tenant_id: string;
}

/** Who is asking: a tenant and a pseudonymous subject, resolved from a verified Cumulus ID session. */
export interface Viewer {
  tenant_id: string;
  subject_id: string;
}

function ref(type: ObjectType, id: string, tenant: string): string {
  return `${tenant}\u0000${type}\u0000${id}`;
}

function tokens(o: OntologyObject): string[] {
  const out = new Set<string>([o.type.toLowerCase(), o.id.toLowerCase()]);
  for (const [k, v] of Object.entries(o.properties)) {
    if (typeof v === "string") for (const t of v.toLowerCase().split(/[^a-z0-9]+/)) if (t) out.add(t);
    out.add(k.toLowerCase());
  }
  return [...out];
}

export class Ontology {
  private objects = new Map<string, OntologyObject>();
  private links: Link[] = [];
  private index = new Map<string, Set<string>>();

  canRead(v: Viewer, o: OntologyObject): boolean {
    if (o.tenant_id !== v.tenant_id) return false;
    if (o.owner === v.subject_id) return true;
    return o.readers.length === 0 ? o.owner === null : o.readers.includes(v.subject_id);
  }

  private unindex(key: string): void {
    for (const set of this.index.values()) set.delete(key);
  }

  private reindex(key: string, o: OntologyObject): void {
    this.unindex(key);
    for (const t of tokens(o)) {
      let s = this.index.get(t);
      if (!s) this.index.set(t, (s = new Set()));
      s.add(key);
    }
  }

  upsert(o: OntologyObject): OntologyObject {
    const key = ref(o.type, o.id, o.tenant_id);
    const prev = this.objects.get(key);
    const merged: OntologyObject = prev
      ? {
          ...prev,
          ...o,
          properties: { ...prev.properties, ...o.properties },
          source_events: [...new Set([...prev.source_events, ...o.source_events])],
        }
      : o;
    this.objects.set(key, merged);
    this.reindex(key, merged);
    return merged;
  }

  /** Internal read without permission checks, for pipelines only. */
  raw(type: ObjectType, id: string, tenant: string): OntologyObject | undefined {
    return this.objects.get(ref(type, id, tenant));
  }

  get(v: Viewer, type: ObjectType, id: string): OntologyObject | undefined {
    const o = this.objects.get(ref(type, id, v.tenant_id));
    return o && this.canRead(v, o) ? o : undefined;
  }

  link(l: Link): void {
    if (!this.links.some((x) => x.type === l.type && x.from === l.from && x.to === l.to && x.tenant_id === l.tenant_id)) this.links.push(l);
  }

  unlink(pred: (l: Link) => boolean): void {
    this.links = this.links.filter((l) => !pred(l));
  }

  linksOf(v: Viewer, type: ObjectType, id: string): Link[] {
    if (!this.get(v, type, id)) return [];
    const k = `${type}:${id}`;
    return this.links.filter((l) => l.tenant_id === v.tenant_id && (l.from === k || l.to === k));
  }

  /** Removes the object, every link touching it and its search-index entries. */
  delete(type: ObjectType, id: string, tenant: string): boolean {
    const key = ref(type, id, tenant);
    if (!this.objects.delete(key)) return false;
    this.unindex(key);
    const k = `${type}:${id}`;
    this.unlink((l) => l.tenant_id === tenant && (l.from === k || l.to === k));
    return true;
  }

  /** Full-text-ish search over authorized objects: every query term must match. */
  search(v: Viewer, q: string, opts: { type?: ObjectType; limit?: number } = {}): OntologyObject[] {
    const terms = q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (!terms.length) return [];
    let hits: Set<string> | undefined;
    for (const t of terms) {
      const s = this.index.get(t) ?? new Set<string>();
      hits = hits ? new Set([...hits].filter((k) => s.has(k))) : new Set(s);
    }
    const out: OntologyObject[] = [];
    for (const k of hits ?? []) {
      const o = this.objects.get(k);
      if (o && (!opts.type || o.type === opts.type) && this.canRead(v, o)) out.push(o);
    }
    out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return out.slice(0, opts.limit ?? 50);
  }

  /** Number of index entries, for tests and metrics. */
  indexSize(): number {
    let n = 0;
    for (const s of this.index.values()) n += s.size;
    return n;
  }

  all(tenant: string, type?: ObjectType): OntologyObject[] {
    return [...this.objects.values()].filter((o) => o.tenant_id === tenant && (!type || o.type === type));
  }
}
