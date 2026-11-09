import type { Activity, Contact, Deal } from "./model.ts";
import { OPEN_STAGES } from "./model.ts";
import type { Appointment, FormSubmission, Message, SmartListFilter } from "./growth-model.ts";

/** Tags are lowercase, trimmed, 1-40 characters of letters, numbers, spaces, dash, underscore or colon. */
export function normalizeTag(tag: string): string | null {
  const t = String(tag ?? "").trim().toLowerCase().replace(/\s+/g, "-");
  return /^[a-z0-9][a-z0-9:_-]{0,39}$/.test(t) ? t : null;
}

export function normalizeTags(tags: unknown): string[] {
  const list = Array.isArray(tags) ? tags : typeof tags === "string" ? tags.split(",") : [];
  return [...new Set(list.map((t) => normalizeTag(String(t))).filter((t): t is string => Boolean(t)))].sort();
}

/** Custom field keys: lowercase identifiers. Values: strings up to 500 characters. */
export function normalizeFields(fields: unknown): Record<string, string> {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields as Record<string, unknown>)) {
    const key = k.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
    if (!key || v === undefined || v === null) continue;
    const value = String(v).trim().slice(0, 500);
    if (value) out[key] = value;
  }
  return out;
}

export interface LeadSignals {
  activities: Activity[];
  deals: Deal[];
  submissions: FormSubmission[];
  appointments: Appointment[];
  messages: Message[];
}

export interface LeadScore {
  score: number; // 0-100
  band: "hot" | "warm" | "cold";
  factors: { label: string; points: number }[];
}

const DAY = 86_400_000;

/**
 * Lead score 0-100 with the reasons shown, from engagement, fit and recency.
 * Transparent points rather than a black box, so people can trust and adjust it.
 */
export function leadScore(c: Contact, s: LeadSignals, now: Date): LeadScore {
  const factors: { label: string; points: number }[] = [];
  const add = (label: string, points: number) => factors.push({ label, points });
  const t = now.getTime();
  const recent = (iso: string, days: number) => t - Date.parse(iso) <= days * DAY;

  const mine = s.activities.filter((a) => a.contactIds.includes(c.id));
  const inbound = mine.filter((a) => a.inbound).length + s.messages.filter((m) => m.contactId === c.id && m.direction === "in").length;
  const meetings = mine.filter((a) => a.kind === "meeting").length;
  const booked = s.appointments.filter((a) => a.contactId === c.id && a.status === "booked");
  const forms = s.submissions.filter((f) => f.contactId === c.id);
  const openDeals = s.deals.filter((d) => d.contactIds.includes(c.id) && OPEN_STAGES.includes(d.stage));
  const won = s.deals.filter((d) => d.contactIds.includes(c.id) && d.stage === "won");

  if (booked.some((a) => Date.parse(a.start) >= t)) add("Has an upcoming meeting booked", 25);
  else if (booked.length) add("Booked a meeting before", 12);
  if (forms.length) add(forms.length > 1 ? `Filled in ${forms.length} forms` : "Filled in a form", Math.min(20, 12 + (forms.length - 1) * 4));
  if (inbound) add(inbound > 1 ? `Reached out ${inbound} times` : "Reached out to you", Math.min(20, 10 + (inbound - 1) * 5));
  if (meetings) add(meetings > 1 ? `${meetings} meetings held` : "1 meeting held", Math.min(15, meetings * 7));
  if (openDeals.length) add("Part of an open deal", 10);
  if (won.length) add("Existing customer", 10);
  if (c.influence === "decision-maker") add("Decision-maker", 10);
  else if (c.influence === "champion") add("Champion", 6);
  if (c.email) add("Has an email address", 3);
  if (c.phone) add("Has a phone number", 2);

  const last = [...mine.map((a) => a.at), ...forms.map((f) => f.at), ...s.messages.filter((m) => m.contactId === c.id && m.direction === "in").map((m) => m.at)]
    .sort().at(-1);
  if (last && recent(last, 7)) add("Active this week", 10);
  else if (!last || !recent(last, 60)) add(last ? "No activity in 60+ days" : "No activity yet", -10);
  if (c.tags?.includes("unqualified")) add("Tagged unqualified", -30);

  const score = Math.max(0, Math.min(100, factors.reduce((n, f) => n + f.points, 0)));
  return { score, band: score >= 60 ? "hot" : score >= 30 ? "warm" : "cold", factors };
}

export function lastActivityAt(c: Contact, activities: Activity[]): string | undefined {
  return activities.filter((a) => a.contactIds.includes(c.id)).map((a) => a.at).sort().at(-1);
}

export function matchesFilter(
  c: Contact,
  f: SmartListFilter,
  ctx: { score: number; lastActivity?: string; companyName?: string; now: Date },
): boolean {
  if (c.optedOut) return false;
  const tags = c.tags ?? [];
  if (f.tags?.length && !f.tags.every((t) => tags.includes(t))) return false;
  if (f.anyTags?.length && !f.anyTags.some((t) => tags.includes(t))) return false;
  if (f.source && c.source !== f.source) return false;
  if (f.minScore !== undefined && ctx.score < f.minScore) return false;
  if (f.hasEmail !== undefined && Boolean(c.email) !== f.hasEmail) return false;
  if (f.hasPhone !== undefined && Boolean(c.phone) !== f.hasPhone) return false;
  if (f.companyId && c.companyId !== f.companyId) return false;
  if (f.createdWithinDays !== undefined && ctx.now.getTime() - Date.parse(c.createdAt) > f.createdWithinDays * DAY) return false;
  if (f.quietForDays !== undefined) {
    const last = ctx.lastActivity ?? c.createdAt;
    if (ctx.now.getTime() - Date.parse(last) < f.quietForDays * DAY) return false;
  }
  if (f.field && (c.fields?.[f.field.key] ?? "").toLowerCase() !== f.field.value.toLowerCase()) return false;
  if (f.text) {
    const q = f.text.toLowerCase();
    const hay = [c.name, c.email, c.phone, c.title, ctx.companyName].filter(Boolean).join(" ").toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

/** Validate a filter from the API: keep known keys with the right types. */
export function cleanFilter(raw: unknown): SmartListFilter {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const f: SmartListFilter = {};
  const tags = normalizeTags(r.tags);
  if (tags.length) f.tags = tags;
  const anyTags = normalizeTags(r.anyTags);
  if (anyTags.length) f.anyTags = anyTags;
  if (typeof r.source === "string" && r.source.trim()) f.source = r.source.trim().slice(0, 100);
  const num = (v: unknown, max: number) => (v === undefined || v === "" || v === null ? undefined : Math.max(0, Math.min(max, Math.round(Number(v)))));
  const minScore = num(r.minScore, 100);
  if (minScore !== undefined && !Number.isNaN(minScore)) f.minScore = minScore;
  for (const k of ["createdWithinDays", "quietForDays"] as const) {
    const v = num(r[k], 3650);
    if (v !== undefined && !Number.isNaN(v)) f[k] = v;
  }
  for (const k of ["hasEmail", "hasPhone"] as const) if (typeof r[k] === "boolean") f[k] = r[k] as boolean;
  if (typeof r.companyId === "string" && r.companyId) f.companyId = r.companyId;
  const field = r.field as { key?: unknown; value?: unknown } | undefined;
  if (field && typeof field.key === "string" && typeof field.value === "string" && field.key.trim()) {
    f.field = { key: Object.keys(normalizeFields({ [field.key]: "x" }))[0] ?? field.key, value: field.value.trim().slice(0, 500) };
  }
  if (typeof r.text === "string" && r.text.trim()) f.text = r.text.trim().slice(0, 100);
  return f;
}
