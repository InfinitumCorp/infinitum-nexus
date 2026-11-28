/**
 * Automations and conversations routes, plus the scheduler endpoint and the SMS webhook.
 */
import { timingSafeEqual } from "node:crypto";
import type { SpectreCRM } from "../core/crm.ts";
import { createWorkflow, deleteWorkflow, getWorkflow, runDue, updateWorkflow, type AutomationEngine } from "../core/automations.ts";
import { receiveSms, sendMessage, threads, verifyTwilioSignature, type Providers } from "../core/messaging.ts";
import { limiter, type GrowthApi } from "./growth-routes.ts";
import { openReview, requestReviews, respondToReview, reviewDashboard, saveReviewSettings } from "../core/reputation.ts";
import { audienceOf, createCampaign, deleteCampaign, getCampaign, runDueCampaigns, sendCampaign, updateCampaign } from "../core/campaigns.ts";

/** A non-JSON response (e.g. TwiML for Twilio). */
export class RawResponse {
  readonly contentType: string;
  readonly body: string;
  readonly status: number;
  constructor(contentType: string, body: string, status = 200) {
    this.contentType = contentType;
    this.body = body;
    this.status = status;
  }
}

export interface EngageApi extends Pick<GrowthApi, "route" | "httpError"> {
  crm: SpectreCRM;
  engine: AutomationEngine;
  providers: Providers;
  /** Shared secret for the scheduler (CRON_SECRET). */
  cronSecret?: string;
  /** Twilio auth token, to verify inbound SMS webhooks. */
  twilioAuthToken?: string;
  /** Public origin, used to rebuild the webhook URL Twilio signed. */
  origin: string;
}

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function registerEngageRoutes(api: EngageApi) {
  const { route, crm, engine, providers, httpError } = api;
  const ws = (ctx: any) => ctx.user.workspace as string;
  const me = (ctx: any) => ctx.user.account.cid as string;

  /* ---------------- Automations ---------------- */

  route("GET", "/api/crm/workflows", (ctx) => {
    const jobs = crm.list("jobs", ws(ctx));
    return crm.list("workflows", ws(ctx))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((w) => ({ ...w, waiting: jobs.filter((j) => j.workflowId === w.id && j.status === "waiting").length }));
  });
  route("POST", "/api/crm/workflows", (ctx) => createWorkflow(crm, ws(ctx), me(ctx), ctx.body));
  route("GET", "/api/crm/workflows/:id", (ctx) => getWorkflow(crm, ws(ctx), ctx.params.id));
  route("PATCH", "/api/crm/workflows/:id", (ctx) => updateWorkflow(crm, ws(ctx), me(ctx), ctx.params.id, ctx.body));
  route("DELETE", "/api/crm/workflows/:id", async (ctx) => { await deleteWorkflow(crm, ws(ctx), me(ctx), ctx.params.id); return { ok: true }; });
  route("GET", "/api/crm/workflows/:id/jobs", (ctx) => {
    getWorkflow(crm, ws(ctx), ctx.params.id);
    const names = new Map(crm.list("contacts", ws(ctx)).map((c) => [c.id, c.name]));
    return crm.list("jobs", ws(ctx))
      .filter((j) => j.workflowId === ctx.params.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 100)
      .map((j) => ({ ...j, contactName: j.contactId ? names.get(j.contactId) : undefined }));
  });

  /** Scheduler: resume waiting automation steps. Called by a cron trigger with CRON_SECRET. */
  route("POST", "/api/cron/automations", async (ctx) => {
    if (!api.cronSecret) throw httpError(503, "Set CRON_SECRET on the server to enable the scheduler");
    const given = String(ctx.req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!given || !sameSecret(given, api.cronSecret)) throw httpError(401, "Wrong scheduler secret");
    return { resumed: await runDue(engine), campaigns: await runDueCampaigns(crm, providers) };
  }, false, { csrf: false });

  /* ---------------- Campaigns ---------------- */

  const audienceView = (ctx: any, audience: unknown, channel: unknown) => {
    const ch = channel === "sms" ? "sms" : "email";
    const a = (audience && typeof audience === "object" ? audience : {}) as { listId?: string; tags?: unknown };
    const r = audienceOf(crm, ws(ctx), { listId: a.listId ? String(a.listId) : undefined, tags: Array.isArray(a.tags) ? a.tags.map(String) : typeof a.tags === "string" ? a.tags.split(",") : undefined }, ch);
    return { total: r.total, optedOut: r.optedOut, noAddress: r.noAddress, capped: r.capped, sample: r.contacts.slice(0, 8).map((c) => c.name) };
  };
  route("GET", "/api/crm/campaigns", (ctx) => crm.list("campaigns", ws(ctx)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  route("POST", "/api/crm/campaigns/preview", (ctx) => audienceView(ctx, ctx.body.audience, ctx.body.channel));
  route("POST", "/api/crm/campaigns", (ctx) => createCampaign(crm, ws(ctx), me(ctx), ctx.body));
  route("GET", "/api/crm/campaigns/:id", (ctx) => {
    const c = getCampaign(crm, ws(ctx), ctx.params.id);
    return { ...c, audienceNow: c.status === "sent" ? undefined : audienceView(ctx, c.audience, c.channel) };
  });
  route("PATCH", "/api/crm/campaigns/:id", (ctx) => updateCampaign(crm, ws(ctx), me(ctx), ctx.params.id, ctx.body));
  route("DELETE", "/api/crm/campaigns/:id", async (ctx) => { await deleteCampaign(crm, ws(ctx), me(ctx), ctx.params.id); return { ok: true }; });
  route("POST", "/api/crm/campaigns/:id/send", (ctx) => sendCampaign(crm, providers, ws(ctx), me(ctx), ctx.params.id));

  /* ---------------- Reputation ---------------- */

  const reviewLimit = limiter(30, 60_000);
  route("GET", "/api/crm/reviews", (ctx) => reviewDashboard(crm, ws(ctx)));
  route("PUT", "/api/crm/reviews/settings", (ctx) => saveReviewSettings(crm, ws(ctx), me(ctx), ctx.body));
  route("POST", "/api/crm/reviews/request", (ctx) =>
    requestReviews(crm, providers, ws(ctx), me(ctx), { contactIds: ctx.body.contactIds, channel: ctx.body.channel, message: ctx.body.message, origin: api.origin }));
  route("GET", "/api/public/reviews/:token", (ctx) => {
    if (!reviewLimit(ctx.req, "open")) throw httpError(429, "Too many requests. Please try again in a minute.");
    return openReview(crm, ctx.params.token);
  }, false);
  route("POST", "/api/public/reviews/:token", (ctx) => {
    if (!reviewLimit(ctx.req, "respond")) throw httpError(429, "Too many requests. Please try again in a minute.");
    return respondToReview(crm, ctx.params.token, ctx.body);
  }, false);

  /* ---------------- Conversations ---------------- */

  route("GET", "/api/crm/conversations", (ctx) => ({
    providers: { email: Boolean(providers.email), sms: Boolean(providers.sms) },
    threads: threads(crm, ws(ctx)),
  }));
  route("GET", "/api/crm/conversations/:contactId", (ctx) => {
    const c = crm.contact(ws(ctx), ctx.params.contactId);
    const msgs = crm.list("messages", ws(ctx)).filter((m) => m.contactId === c.id).sort((a, b) => a.at.localeCompare(b.at));
    return {
      contact: { id: c.id, name: c.name, email: c.email, phone: c.phone, optedOut: !!c.optedOut },
      messages: msgs,
      unread: msgs.filter((m) => m.direction === "in" && !m.read).length,
    };
  });
  route("POST", "/api/crm/conversations/:contactId/read", (ctx) => {
    crm.contact(ws(ctx), ctx.params.contactId);
    for (const m of crm.list("messages", ws(ctx))) if (m.contactId === ctx.params.contactId) m.read = true;
    return { ok: true };
  });
  route("POST", "/api/crm/conversations/:contactId", (ctx) =>
    sendMessage(crm, providers, ws(ctx), me(ctx), { contactId: ctx.params.contactId, channel: ctx.body.channel, subject: ctx.body.subject, body: ctx.body.body }));

  /** Twilio inbound SMS webhook. Signed with the account's auth token; STOP opts the sender out. */
  route("POST", "/api/hooks/twilio/sms", async (ctx) => {
    if (!api.twilioAuthToken) throw httpError(503, "SMS isn't connected");
    const params = Object.fromEntries(Object.entries(ctx.body).map(([k, v]) => [k, String(v)]));
    const url = api.origin + ctx.req.url;
    if (!verifyTwilioSignature(api.twilioAuthToken, url, params, ctx.req.headers["x-twilio-signature"] as string | undefined)) {
      throw httpError(403, "Bad signature");
    }
    await receiveSms(crm, params.From ?? "", params.Body ?? "", params.MessageSid);
    return new RawResponse("text/xml; charset=utf-8", '<?xml version="1.0" encoding="UTF-8"?><Response/>');
  }, false, { csrf: false });
}
