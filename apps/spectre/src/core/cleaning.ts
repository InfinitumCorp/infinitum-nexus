import type { Activity, Company, Contact, Deal } from "./model.ts";

/**
 * Self-cleaning data: duplicates found and merged, outdated contacts flagged.
 */

const LEGAL_SUFFIX = /\b(inc|llc|ltd|limited|corp|corporation|co|company|gmbh|plc|bv|sa|ag|group|holdings)\b\.?/g;

export function normalizeCompanyName(name: string): string {
  return name.toLowerCase().replace(/&/g, " and ").replace(LEGAL_SUFFIX, " ").replace(/[^a-z0-9]+/g, " ").trim();
}

export function normalizePersonName(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Similarity 0..1 from character bigrams (Dice coefficient): tolerant of typos and word order. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    const t = s.replace(/\s+/g, " ");
    for (let i = 0; i < t.length - 1; i++) m.set(t.slice(i, i + 2), (m.get(t.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const ga = grams(a), gb = grams(b);
  let overlap = 0, total = 0;
  for (const [g, n] of ga) { overlap += Math.min(n, gb.get(g) ?? 0); total += n; }
  for (const n of gb.values()) total += n;
  return total === 0 ? 0 : (2 * overlap) / total;
}

export interface DuplicateGroup<T> {
  keep: T;
  duplicates: T[];
  reason: string;
}

export function findDuplicateCompanies(companies: Company[], threshold = 0.85): DuplicateGroup<Company>[] {
  const groups: DuplicateGroup<Company>[] = [];
  const used = new Set<string>();
  const sorted = [...companies].sort((a, b) => a.createdAt.localeCompare(b.createdAt)); // keep the oldest
  for (const c of sorted) {
    if (used.has(c.id)) continue;
    const dups: Company[] = [];
    let reason = "";
    for (const o of sorted) {
      if (o.id === c.id || used.has(o.id)) continue;
      if (c.domain && o.domain && c.domain === o.domain) { dups.push(o); reason = `Same website (${c.domain})`; }
      else if (similarity(normalizeCompanyName(c.name), normalizeCompanyName(o.name)) >= threshold) { dups.push(o); reason ||= "Nearly identical names"; }
    }
    if (dups.length) {
      dups.forEach((d) => used.add(d.id));
      used.add(c.id);
      groups.push({ keep: c, duplicates: dups, reason });
    }
  }
  return groups;
}

export function findDuplicateContacts(contacts: Contact[], threshold = 0.9): DuplicateGroup<Contact>[] {
  const groups: DuplicateGroup<Contact>[] = [];
  const used = new Set<string>();
  const live = contacts.filter((c) => !c.optedOut).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const c of live) {
    if (used.has(c.id)) continue;
    const dups: Contact[] = [];
    let reason = "";
    for (const o of live) {
      if (o.id === c.id || used.has(o.id)) continue;
      if (c.email && o.email && c.email === o.email) { dups.push(o); reason = "Same email address"; }
      else if (c.companyId && c.companyId === o.companyId &&
        similarity(normalizePersonName(c.name), normalizePersonName(o.name)) >= threshold) { dups.push(o); reason ||= "Same name at the same company"; }
    }
    if (dups.length) {
      dups.forEach((d) => used.add(d.id));
      used.add(c.id);
      groups.push({ keep: c, duplicates: dups, reason });
    }
  }
  return groups;
}

/** Fill the kept contact's empty fields from its duplicates. */
export function mergeContactFields(keep: Contact, dups: Contact[]): Contact {
  const merged = { ...keep };
  for (const d of dups) {
    for (const k of ["title", "email", "phone", "companyId", "influence"] as const) {
      if (merged[k] === undefined && d[k] !== undefined) (merged as Record<string, unknown>)[k] = d[k];
    }
  }
  return merged;
}

/** Re-point deals and activities from merged records to the kept one. */
export function repointReferences(keptId: string, mergedIds: string[], deals: Deal[], activities: Activity[]) {
  const gone = new Set(mergedIds);
  for (const d of deals) {
    if (gone.has(d.companyId)) d.companyId = keptId;
    d.contactIds = [...new Set(d.contactIds.map((id) => (gone.has(id) ? keptId : id)))];
  }
  for (const a of activities) {
    if (a.companyId && gone.has(a.companyId)) a.companyId = keptId;
    a.contactIds = [...new Set(a.contactIds.map((id) => (gone.has(id) ? keptId : id)))];
  }
}

export interface DataIssue {
  recordId: string;
  kind: "missing_field" | "stale_contact";
  message: string;
}

/** Contacts with no activity in `staleDays`, and records missing key fields. */
export function dataIssues(contacts: Contact[], companies: Company[], activities: Activity[], now: Date, staleDays = 180): DataIssue[] {
  const issues: DataIssue[] = [];
  const lastTouch = new Map<string, number>();
  for (const a of activities) for (const id of a.contactIds) lastTouch.set(id, Math.max(lastTouch.get(id) ?? 0, Date.parse(a.at)));
  for (const c of contacts) {
    if (c.optedOut) continue;
    if (!c.email && !c.phone) issues.push({ recordId: c.id, kind: "missing_field", message: `${c.name} has no email or phone` });
    const t = lastTouch.get(c.id) ?? Date.parse(c.createdAt);
    const days = (now.getTime() - t) / 86_400_000;
    if (days > staleDays) issues.push({ recordId: c.id, kind: "stale_contact", message: `${c.name}: no contact in ${Math.round(days)} days; check they're still in role` });
  }
  for (const co of companies) if (!co.domain) issues.push({ recordId: co.id, kind: "missing_field", message: `${co.name} has no website` });
  return issues;
}

/** CRM-facing wrappers used by the duplicate-merge flow. */
export function findCompanyDuplicates(
  crm: { list(kind: "companies", workspace: string): Company[] },
  workspace: string,
) {
  return findDuplicateCompanies(crm.list("companies", workspace)).map((g) => ({
    ...g,
    reason: g.reason.startsWith("Same website") ? "same domain" : g.reason,
  }));
}

export function mergeCompanies(
  crm: { company(workspace: string, id: string): Company; store: { companies: Map<string, Company> } },
  workspace: string,
  _actor: string,
  keepId: string,
  duplicateIds: string[],
) {
  const keep = crm.company(workspace, keepId);
  for (const id of duplicateIds) crm.store.companies.delete(id);
  return keep;
}
