/**
 * Relationship map helpers for the Spectre UI.
 */
import type { SpectreCRM } from "../core/crm.ts";
import type { Relationship } from "../core/model.ts";

export interface RelNode {
  id: string;
  label: string;
  kind: "contact" | "cid" | "unknown";
}

export interface RelEdge {
  id: string;
  from: string;
  to: string;
  strength: number;
  note?: string;
}

export function buildMap(crm: SpectreCRM, workspace: string) {
  const rels = crm.list("relationships", workspace) as Relationship[];
  const contacts = crm.list("contacts", workspace);
  const contactById = new Map(contacts.map((c) => [c.id, c]));

  const nodes = new Map<string, RelNode>();
  const edges: RelEdge[] = [];

  function ensure(id: string): RelNode {
    let n = nodes.get(id);
    if (n) return n;
    if (id.startsWith("cid:")) {
      n = { id, label: id, kind: "cid" };
    } else {
      const c = contactById.get(id);
      n = { id, label: c?.name ?? id, kind: c ? "contact" : "unknown" };
    }
    nodes.set(id, n);
    return n;
  }

  for (const r of rels) {
    ensure(r.from);
    ensure(r.to);
    edges.push({ id: r.id, from: r.from, to: r.to, strength: r.strength, note: r.note });
  }

  return { nodes: [...nodes.values()], edges };
}
