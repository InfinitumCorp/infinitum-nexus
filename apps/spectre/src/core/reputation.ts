/**
 * Reputation: ask customers for a review by email or SMS, with a private link per person.
 * The link opens a short page: a 1–5 rating, the public review link (Google or any review site)
 * and an optional private note. Everyone sees the public link whatever they rate: steering only
 * happy customers to public reviews ("review gating") breaks Google's review policy.
 * A low rating or a private note becomes a follow-up task. Message and feedback text stay off the ledger.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { SpectreCRM } from "./crm.ts";
import { SpectreError } from "./crm.ts";
import { sendMessage, type Providers } from "./messaging.ts";

export interface ReviewSettings {
  /** The workspace id doubles as the key: one settings record per workspace. */
  id: string;
  workspace: string;
  businessName: string;
  /** Where public reviews go, e.g. a Google "write a review" link. https only. */
  reviewUrl?: string;
  updatedAt: string;
}

export interface ReviewRequest {
  id: string;
  workspace: string;
  contactId: string;
  channel: "email" | "sms";
  /** Unguessable token in the link; identifies the request on the public page. */
  token: string;
  messageStatus: "sent" | "draft" | "failed";
  sentAt: string;
  sentBy: string;
  openedAt?: string;
  rating?: number;
  ratedAt?: string;
  clickedAt?: string;
  feedback?: string;
  taskId?: string;
}

export const REVIEW_LIMITS = { perSend: 200, repeatDays: 30, feedback: 2000 };
const DAY = 86_400_000;

export function reviewSettings(crm: SpectreCRM, ws: string): ReviewSettings {
  return crm.store.reviewSettings.get(ws) ?? { id: ws, workspace: ws, businessName: "", updatedAt: "" };
}

export async function saveReviewSettings(crm: SpectreCRM, ws: string, actor: string, raw: Record<string, unknown>): Promise<ReviewSettings> {
  const businessName = String(raw.businessName ?? "").trim().slice(0, 120);
  let reviewUrl: string | undefined;
  if (raw.reviewUrl) {
    let u: URL;
    try { u = new URL(String(raw.reviewUrl).trim()); } catch { throw new SpectreError("invalid", "The review link isn't a valid web address"); }
    if (u.protocol !== "https:") throw new SpectreError("invalid", "The review link must start with https://");
    reviewUrl = u.toString();
  }
  const s: ReviewSettings = { id: ws, workspace: ws, businessName, reviewUrl, updatedAt: crm.now().toISOString() };
  crm.store.reviewSettings.set(ws, s);
  await crm.record(actor, `reviews:${ws}`, { event: "reviews.settings", hasLink: Boolean(reviewUrl) });
  return s;
}

const defaultMessage = (channel: "email" | "sms", business: string) =>
  channel === "sms"
    ? `Hi {{first_name}}, thanks for choosing ${business}! Could you take 30 seconds to rate us? {{review_link}}`
    : `Hi {{first_name}},\n\nThank you for choosing ${business}. How did we do? It takes 30 seconds:\n\n{{review_link}}\n\nThank you!`;

/** Ask people for a review. Skips anyone asked in the last 30 days, opted out, or without an address. */
export async function requestReviews(
  crm: SpectreCRM, providers: Providers, ws: string, actor: string,
  input: { contactIds: unknown; channel?: unknown; message?: unknown; origin: string },
) {
  const settings = reviewSettings(crm, ws);
  if (!settings.reviewUrl) throw new SpectreError("invalid", "Add your review link first");
  const business = settings.businessName || "us";
  const channel = input.channel === "sms" ? "sms" : "email";
  const ids = Array.isArray(input.contactIds) ? [...new Set(input.contactIds.map(String))].slice(0, REVIEW_LIMITS.perSend) : [];
  if (!ids.length) throw new SpectreError("invalid", "Choose who to ask");
  const template = String(input.message ?? "").trim().slice(0, 2000) || defaultMessage(channel, business);
  if (!template.includes("{{review_link}}")) throw new SpectreError("invalid", "Keep {{review_link}} in the message");
  const now = crm.now();
  const recent = new Set(crm.list("reviewRequests", ws).filter((r) => now.getTime() - Date.parse(r.sentAt) < REVIEW_LIMITS.repeatDays * DAY).map((r) => r.contactId));
  const out = { requested: 0, sent: 0, drafted: 0, failed: 0, skipped: [] as { contactId: string; reason: string }[] };
  for (const id of ids) {
    const c = crm.store.contacts.get(id);
    if (!c || c.workspace !== ws) { out.skipped.push({ contactId: id, reason: "not found" }); continue; }
    if (c.optedOut) { out.skipped.push({ contactId: id, reason: "opted out" }); continue; }
    if (recent.has(id)) { out.skipped.push({ contactId: id, reason: `asked in the last ${REVIEW_LIMITS.repeatDays} days` }); continue; }
    if (channel === "email" ? !c.email : !c.phone) { out.skipped.push({ contactId: id, reason: channel === "email" ? "no email" : "no phone" }); continue; }
    const token = randomBytes(18).toString("base64url");
    const link = `${input.origin.replace(/\/$/, "")}/review.html?t=${token}`;
    const m = await sendMessage(crm, providers, ws, actor, {
      contactId: id, channel, subject: channel === "email" ? `How did we do, {{first_name}}?` : undefined, body: template.split("{{review_link}}").join(link),
    });
    const r: ReviewRequest = {
      id: `rv_${randomUUID()}`, workspace: ws, contactId: id, channel, token,
      messageStatus: m.status === "sent" ? "sent" : m.status === "draft" ? "draft" : "failed", sentAt: now.toISOString(), sentBy: actor,
    };
    crm.store.reviewRequests.set(r.id, r);
    out.requested++;
    out[r.messageStatus === "sent" ? "sent" : r.messageStatus === "draft" ? "drafted" : "failed"]++;
  }
  await crm.record(actor, `reviews:${ws}`, { event: "reviews.requested", channel, requested: out.requested, sent: out.sent, skipped: out.skipped.length });
  return out;
}

function byToken(crm: SpectreCRM, token: string): ReviewRequest {
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(token)) throw new SpectreError("not_found", "This review link isn't valid");
  for (const r of crm.store.reviewRequests.values()) if (r.token === token) return r;
  throw new SpectreError("not_found", "This review link isn't valid");
}

/** What the public page shows. Opening the link counts as opened. */
export function openReview(crm: SpectreCRM, token: string) {
  const r = byToken(crm, token);
  r.openedAt ??= crm.now().toISOString();
  const s = reviewSettings(crm, r.workspace);
  const first = (crm.store.contacts.get(r.contactId)?.name ?? "").split(/\s+/)[0] ?? "";
  return { business: s.businessName || "us", reviewUrl: s.reviewUrl, firstName: first, rating: r.rating, done: Boolean(r.feedback) };
}

/** A rating, a click on the public review link, or a private note, from the public page. */
export async function respondToReview(crm: SpectreCRM, token: string, raw: Record<string, unknown>) {
  const r = byToken(crm, token);
  const now = crm.now().toISOString();
  if (raw.rating !== undefined) {
    const n = Number(raw.rating);
    if (!Number.isInteger(n) || n < 1 || n > 5) throw new SpectreError("invalid", "Pick 1 to 5 stars");
    r.rating = n;
    r.ratedAt = now;
  }
  if (raw.clicked) r.clickedAt ??= now;
  const feedback = String(raw.feedback ?? "").trim().slice(0, REVIEW_LIMITS.feedback);
  if (feedback) r.feedback = feedback;
  // Someone unhappy, or who wrote to us: a person should follow up (once per request).
  if (!r.taskId && (feedback || (r.rating !== undefined && r.rating <= 3))) {
    const name = crm.store.contacts.get(r.contactId)?.name ?? "a customer";
    const task = await crm.logActivity(r.workspace, "cid:spectre", {
      kind: "task", summary: `Follow up on ${r.rating ? `${r.rating}★ ` : ""}feedback from ${name}`, contactIds: [r.contactId],
      dueAt: new Date(Date.parse(now) + DAY).toISOString(),
    });
    r.taskId = task.id;
  }
  await crm.record("cid:spectre", `review:${r.id}`, { event: "review.response", rating: r.rating ?? null, clicked: Boolean(r.clickedAt), feedback: Boolean(r.feedback) });
  return { ok: true, reviewUrl: reviewSettings(crm, r.workspace).reviewUrl };
}

/** The Reputation page: settings, requests with names, and totals. */
export function reviewDashboard(crm: SpectreCRM, ws: string) {
  const names = new Map(crm.list("contacts", ws).map((c) => [c.id, c.name]));
  const requests = crm.list("reviewRequests", ws).sort((a, b) => b.sentAt.localeCompare(a.sentAt));
  const rated = requests.filter((r) => r.rating !== undefined);
  return {
    settings: reviewSettings(crm, ws),
    stats: {
      requested: requests.length,
      opened: requests.filter((r) => r.openedAt).length,
      rated: rated.length,
      average: rated.length ? Math.round((rated.reduce((s, r) => s + r.rating!, 0) / rated.length) * 10) / 10 : null,
      clicked: requests.filter((r) => r.clickedAt).length,
      feedback: requests.filter((r) => r.feedback).length,
    },
    requests: requests.slice(0, 300).map(({ token: _t, ...r }) => ({ ...r, name: names.get(r.contactId) ?? "Removed" })),
  };
}
