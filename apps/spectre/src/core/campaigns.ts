/**
 * Campaigns: one email or SMS sent to many people (a tag or a smart list), now or at a set time.
 * Each recipient goes through sendMessage, so opt-outs, merge fields ({{first_name}}…), providers
 * and drafts work exactly as in Conversations. Message text stays off the ledger.
 */
import { randomUUID } from "node:crypto";
import type { SpectreCRM } from "./crm.ts";
import { SpectreError } from "./crm.ts";
import type { Contact } from "./model.ts";
import { cleanFilter, lastActivityAt, leadScore, matchesFilter, normalizeTags } from "./contacts-plus.ts";
import type { SmartListFilter } from "./growth-model.ts";
import { sendMessage, type Providers } from "./messaging.ts";

export type CampaignStatus = "draft" | "scheduled" | "sending" | "sent" | "cancelled";

export interface CampaignAudience {
  /** A saved smart list, or tags (people with any of them), or everyone when neither is set. */
  listId?: string;
  tags?: string[];
}

export interface Campaign {
  id: string;
  workspace: string;
  name: string;
  channel: "email" | "sms";
  subject?: string;
  body: string;
  audience: CampaignAudience;
  status: CampaignStatus;
  scheduledAt?: string;
  sentAt?: string;
  stats: { recipients: number; sent: number; drafted: number; failed: number; skipped: number };
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export const CAMPAIGN_LIMITS = { recipients: 5000, perWorkspace: 500, body: 5000 };

const zeroStats = () => ({ recipients: 0, sent: 0, drafted: 0, failed: 0, skipped: 0 });

function clean(crm: SpectreCRM, ws: string, raw: Record<string, unknown>) {
  const name = String(raw.name ?? "").trim().slice(0, 120);
  if (!name) throw new SpectreError("invalid", "Give the campaign a name");
  const channel = raw.channel === "sms" ? "sms" : raw.channel === "email" || raw.channel === undefined ? "email" : null;
  if (!channel) throw new SpectreError("invalid", "Channel must be email or sms");
  const body = String(raw.body ?? "").trim().slice(0, CAMPAIGN_LIMITS.body);
  if (!body) throw new SpectreError("invalid", "Write the message");
  const subject = channel === "email" ? String(raw.subject ?? "").trim().slice(0, 300) : undefined;
  if (channel === "email" && !subject) throw new SpectreError("invalid", "Add a subject");
  const a = (raw.audience && typeof raw.audience === "object" ? raw.audience : {}) as Record<string, unknown>;
  const audience: CampaignAudience = {};
  if (a.listId) {
    const list = crm.store.smartLists.get(String(a.listId));
    if (!list || list.workspace !== ws) throw new SpectreError("invalid", "That list doesn't exist");
    audience.listId = list.id;
  } else {
    const tags = normalizeTags(a.tags);
    if (tags.length) audience.tags = tags;
  }
  let scheduledAt: string | undefined;
  if (raw.scheduledAt) {
    const t = Date.parse(String(raw.scheduledAt));
    if (!Number.isFinite(t)) throw new SpectreError("invalid", "Pick a valid send time");
    scheduledAt = new Date(t).toISOString();
  }
  return { name, channel, subject, body, audience, scheduledAt } as const;
}

/** The people a campaign reaches right now, and why others are left out. */
export function audienceOf(crm: SpectreCRM, ws: string, audience: CampaignAudience, channel: "email" | "sms") {
  let filter: SmartListFilter = {};
  if (audience.listId) {
    const list = crm.store.smartLists.get(audience.listId);
    if (!list || list.workspace !== ws) throw new SpectreError("invalid", "That list was deleted");
    filter = list.filter;
  } else if (audience.tags?.length) {
    filter = cleanFilter({ anyTags: audience.tags });
  }
  const now = crm.now();
  const signals = {
    activities: crm.list("activities", ws), deals: crm.list("deals", ws), submissions: crm.list("submissions", ws),
    appointments: crm.list("appointments", ws), messages: crm.list("messages", ws),
  };
  const companies = new Map(crm.list("companies", ws).map((c) => [c.id, c.name]));
  const matched: Contact[] = [];
  let optedOut = 0;
  let noAddress = 0;
  for (const c of crm.list("contacts", ws)) {
    const ok = matchesFilter(c, filter, { score: leadScore(c, signals, now).score, lastActivity: lastActivityAt(c, signals.activities), companyName: c.companyId ? companies.get(c.companyId) : undefined, now });
    if (!ok) continue;
    if (c.optedOut) { optedOut++; continue; }
    if (channel === "email" ? !c.email : !c.phone) { noAddress++; continue; }
    matched.push(c);
  }
  return { contacts: matched.slice(0, CAMPAIGN_LIMITS.recipients), total: matched.length, optedOut, noAddress, capped: matched.length > CAMPAIGN_LIMITS.recipients };
}

export async function createCampaign(crm: SpectreCRM, ws: string, actor: string, raw: Record<string, unknown>): Promise<Campaign> {
  if (crm.list("campaigns", ws).length >= CAMPAIGN_LIMITS.perWorkspace) throw new SpectreError("invalid", `A workspace can keep ${CAMPAIGN_LIMITS.perWorkspace} campaigns; delete an old one first`);
  const input = clean(crm, ws, raw);
  const at = crm.now().toISOString();
  const c: Campaign = { id: `cp_${randomUUID()}`, workspace: ws, ...input, status: "draft", stats: zeroStats(), createdBy: actor, createdAt: at, updatedAt: at };
  if (c.scheduledAt) c.status = "scheduled";
  crm.store.campaigns.set(c.id, c);
  await crm.record(actor, `campaign:${c.id}`, { event: "campaign.created", channel: c.channel, status: c.status });
  return c;
}

export function getCampaign(crm: SpectreCRM, ws: string, id: string): Campaign {
  const c = crm.store.campaigns.get(id);
  if (!c || c.workspace !== ws) throw new SpectreError("not_found", "Campaign not found");
  return c;
}

export async function updateCampaign(crm: SpectreCRM, ws: string, actor: string, id: string, raw: Record<string, unknown>): Promise<Campaign> {
  const c = getCampaign(crm, ws, id);
  if (c.status === "sent" || c.status === "sending") throw new SpectreError("invalid", "This campaign was already sent");
  if (raw.status === "cancelled") {
    c.status = "cancelled";
  } else {
    const input = clean(crm, ws, { ...c, ...raw });
    Object.assign(c, input, { status: input.scheduledAt ? "scheduled" : "draft" });
    if (!input.scheduledAt) delete c.scheduledAt;
  }
  c.updatedAt = crm.now().toISOString();
  await crm.record(actor, `campaign:${c.id}`, { event: "campaign.updated", status: c.status });
  return c;
}

export async function deleteCampaign(crm: SpectreCRM, ws: string, actor: string, id: string) {
  const c = getCampaign(crm, ws, id);
  if (c.status === "sending") throw new SpectreError("invalid", "Wait until it finishes sending");
  crm.store.campaigns.delete(c.id);
  await crm.record(actor, `campaign:${c.id}`, { event: "campaign.deleted" });
}

/** Send to everyone in the audience. A campaign sends once. */
export async function sendCampaign(crm: SpectreCRM, providers: Providers, ws: string, actor: string, id: string): Promise<Campaign> {
  const c = getCampaign(crm, ws, id);
  if (c.status === "sent" || c.status === "sending") throw new SpectreError("invalid", "This campaign was already sent");
  if (c.status === "cancelled") throw new SpectreError("invalid", "This campaign was cancelled");
  const aud = audienceOf(crm, ws, c.audience, c.channel);
  c.status = "sending";
  c.stats = { ...zeroStats(), recipients: aud.contacts.length, skipped: aud.optedOut + aud.noAddress };
  for (const person of aud.contacts) {
    try {
      const m = await sendMessage(crm, providers, ws, actor, { contactId: person.id, channel: c.channel, subject: c.subject, body: c.body });
      if (m.status === "sent") c.stats.sent++; else if (m.status === "draft") c.stats.drafted++; else c.stats.failed++;
    } catch {
      c.stats.skipped++;
    }
  }
  c.status = "sent";
  c.sentAt = crm.now().toISOString();
  c.updatedAt = c.sentAt;
  await crm.record(actor, `campaign:${c.id}`, { event: "campaign.sent", channel: c.channel, ...c.stats });
  return c;
}

/** Scheduler: send campaigns whose time has come. */
export async function runDueCampaigns(crm: SpectreCRM, providers: Providers, ws?: string) {
  const now = crm.now().toISOString();
  const due = [...crm.store.campaigns.values()].filter((c) => c.status === "scheduled" && c.scheduledAt && c.scheduledAt <= now && (!ws || c.workspace === ws));
  for (const c of due) await sendCampaign(crm, providers, c.workspace, c.createdBy, c.id);
  return due.length;
}
