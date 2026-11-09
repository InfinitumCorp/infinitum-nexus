import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { SpectreCRM } from "../core/crm.ts";
import { SpectreError } from "../core/crm.ts";
import { cleanFilter, lastActivityAt, leadScore, matchesFilter, normalizeFields, normalizeTags, type LeadSignals } from "../core/contacts-plus.ts";
import { createForm, submitForm, updateForm } from "../core/forms.ts";
import { availableSlots, book, cancelAppointment, createCalendar, icsFor, updateCalendar } from "../core/calendar.ts";
import type { SmartList } from "../core/growth-model.ts";

/** What the growth routes need from the app (kept narrow so app.ts stays the single router). */
export interface GrowthApi {
  route: (method: string, path: string, handler: (ctx: any) => unknown, auth?: boolean, opts?: { csrf?: boolean; optionalAuth?: boolean }) => void;
  crm: SpectreCRM;
  httpError: (status: number, message: string) => Error;
  /** Automations hook: called after events like a form submission or a new tag. */
  emit: (ws: string, event: GrowthEvent) => Promise<void>;
}

export type { GrowthEvent } from "../core/growth-model.ts";
import type { GrowthEvent } from "../core/growth-model.ts";

/** Per-IP limit for public endpoints (best effort per instance). */
function limiter(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (req: IncomingMessage, key: string) => {
    const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "?").split(",")[0].trim();
    const k = `${ip}|${key}`;
    const now = Date.now();
    const recent = (hits.get(k) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) return false;
    recent.push(now);
    hits.set(k, recent);
    if (hits.size > 5000) hits.clear();
    return true;
  };
}

export function signalsFor(crm: SpectreCRM, ws: string): LeadSignals {
  return {
    activities: crm.list("activities", ws),
    deals: crm.list("deals", ws),
    submissions: crm.list("submissions", ws),
    appointments: crm.list("appointments", ws),
    messages: crm.list("messages", ws),
  };
}

export function registerGrowthRoutes(api: GrowthApi) {
  const { route, crm, httpError, emit } = api;
  const publicLimit = limiter(10, 60_000);

  /* ---------------- Contacts: tags, fields, scores, smart lists ---------------- */

  const contactRows = (ws: string) => {
    const s = signalsFor(crm, ws);
    const now = crm.now();
    const companies = new Map(crm.list("companies", ws).map((c) => [c.id, c.name]));
    return crm.list("contacts", ws).filter((c) => !c.optedOut).map((c) => {
      const score = leadScore(c, s, now);
      return { contact: c, score, lastActivity: lastActivityAt(c, s.activities), companyName: c.companyId ? companies.get(c.companyId) : undefined };
    });
  };

  const view = (r: ReturnType<typeof contactRows>[number]) => ({
    ...r.contact, company: r.companyName, score: r.score.score, band: r.score.band, lastActivity: r.lastActivity,
  });

  /** Contacts with score, filterable (?list=<smartListId> or filter params). */
  route("GET", "/api/crm/contacts", (ctx) => {
    const ws = ctx.user.workspace;
    let filter = cleanFilter({
      tags: ctx.query.get("tags") ?? undefined, text: ctx.query.get("q") ?? undefined, source: ctx.query.get("source") ?? undefined,
      minScore: ctx.query.get("minScore") ?? undefined,
    });
    const listId = ctx.query.get("list");
    if (listId) {
      const list = crm.store.smartLists.get(listId);
      if (!list || list.workspace !== ws) throw httpError(404, "List not found");
      filter = list.filter;
    }
    const now = crm.now();
    const rows = contactRows(ws).filter((r) => matchesFilter(r.contact, filter, { score: r.score.score, lastActivity: r.lastActivity, companyName: r.companyName, now }));
    const sort = ctx.query.get("sort") ?? "score";
    rows.sort((a, b) => sort === "name" ? a.contact.name.localeCompare(b.contact.name)
      : sort === "recent" ? b.contact.createdAt.localeCompare(a.contact.createdAt)
      : b.score.score - a.score.score);
    const tags = new Map<string, number>();
    for (const r of contactRows(ws)) for (const t of r.contact.tags ?? []) tags.set(t, (tags.get(t) ?? 0) + 1);
    return { contacts: rows.slice(0, 500).map(view), total: rows.length, tags: [...tags].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count) };
  });

  route("GET", "/api/crm/contacts/:id/score", (ctx) => {
    const ws = ctx.user.workspace;
    return leadScore(crm.contact(ws, ctx.params.id), signalsFor(crm, ws), crm.now());
  });

  route("POST", "/api/crm/contacts/:id/tags", async (ctx) => {
    const ws = ctx.user.workspace;
    const c = crm.contact(ws, ctx.params.id);
    const add = normalizeTags(ctx.body.add);
    const remove = new Set(normalizeTags(ctx.body.remove));
    const before = new Set(c.tags ?? []);
    const tags = normalizeTags([...(c.tags ?? []).filter((t) => !remove.has(t)), ...add]);
    const next = await crm.updateContact(ws, ctx.user.account.cid, c.id, { tags });
    for (const t of tags.filter((t) => !before.has(t))) await emit(ws, { type: "tag.added", contactId: c.id, tag: t });
    return next;
  });

  route("POST", "/api/crm/contacts/:id/fields", async (ctx) => {
    const ws = ctx.user.workspace;
    const c = crm.contact(ws, ctx.params.id);
    const fields = { ...c.fields, ...normalizeFields(ctx.body.set) };
    for (const k of normalizeTags(ctx.body.unset)) delete fields[k.replace(/-/g, "_")];
    const source = typeof ctx.body.source === "string" ? ctx.body.source.trim().slice(0, 100) || undefined : c.source;
    return crm.updateContact(ws, ctx.user.account.cid, c.id, { fields, source });
  });

  /** Bulk tag: apply to every contact in a filter or list (e.g. tag a whole segment). */
  route("POST", "/api/crm/contacts/bulk-tag", async (ctx) => {
    const ws = ctx.user.workspace;
    const ids: string[] = Array.isArray(ctx.body.ids) ? ctx.body.ids.slice(0, 1000).map(String) : [];
    const add = normalizeTags(ctx.body.add);
    if (!ids.length || !add.length) throw httpError(400, "Choose contacts and at least one tag");
    let changed = 0;
    for (const id of ids) {
      const c = crm.contact(ws, id);
      const before = new Set(c.tags ?? []);
      const fresh = add.filter((t) => !before.has(t));
      if (!fresh.length) continue;
      await crm.updateContact(ws, ctx.user.account.cid, id, { tags: normalizeTags([...before, ...fresh]) });
      for (const t of fresh) await emit(ws, { type: "tag.added", contactId: id, tag: t });
      changed++;
    }
    return { changed };
  });

  route("GET", "/api/crm/lists", (ctx) => {
    const ws = ctx.user.workspace;
    const rows = contactRows(ws);
    const now = crm.now();
    return crm.list("smartLists", ws).sort((a, b) => a.name.localeCompare(b.name)).map((l) => ({
      ...l, count: rows.filter((r) => matchesFilter(r.contact, l.filter, { score: r.score.score, lastActivity: r.lastActivity, companyName: r.companyName, now })).length,
    }));
  });

  route("POST", "/api/crm/lists", async (ctx) => {
    const name = String(ctx.body.name ?? "").trim().slice(0, 80);
    if (!name) throw httpError(400, "Name the list");
    const filter = cleanFilter(ctx.body.filter);
    if (!Object.keys(filter).length) throw httpError(400, "Add at least one condition");
    const list: SmartList = { id: `sl_${randomUUID()}`, workspace: ctx.user.workspace, name, filter, createdAt: crm.now().toISOString() };
    crm.store.smartLists.set(list.id, list);
    await crm.record(ctx.user.account.cid, `list:${list.id}`, { event: "list.created" });
    return list;
  });

  route("DELETE", "/api/crm/lists/:id", async (ctx) => {
    const l = crm.store.smartLists.get(ctx.params.id);
    if (!l || l.workspace !== ctx.user.workspace) throw httpError(404, "List not found");
    crm.store.smartLists.delete(l.id);
    await crm.record(ctx.user.account.cid, `list:${l.id}`, { event: "list.deleted" });
    return { ok: true };
  });

  /* ---------------- Forms ---------------- */

  route("GET", "/api/crm/forms", (ctx) => {
    const ws = ctx.user.workspace;
    const subs = crm.list("submissions", ws);
    return crm.list("forms", ws).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((f) => {
      const mine = subs.filter((s) => s.formId === f.id);
      return { ...f, submissions: mine.length, lastSubmission: mine.map((s) => s.at).sort().at(-1) };
    });
  });

  route("POST", "/api/crm/forms", (ctx) => createForm(crm, ctx.user.workspace, ctx.user.account.cid, ctx.body));
  route("PATCH", "/api/crm/forms/:id", (ctx) => updateForm(crm, ctx.user.workspace, ctx.user.account.cid, ctx.params.id, ctx.body));

  route("GET", "/api/crm/forms/:id/submissions", (ctx) => {
    const ws = ctx.user.workspace;
    const f = crm.store.forms.get(ctx.params.id);
    if (!f || f.workspace !== ws) throw httpError(404, "Form not found");
    return crm.list("submissions", ws).filter((s) => s.formId === f.id).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200)
      .map((s) => ({ ...s, contactName: crm.store.contacts.get(s.contactId)?.name }));
  });

  /** Public: the form's questions (no workspace data). */
  route("GET", "/api/public/forms/:id", (ctx) => {
    const f = crm.store.forms.get(ctx.params.id);
    if (!f || !f.active) throw httpError(404, "This form isn't available");
    return { id: f.id, name: f.name, headline: f.headline, fields: f.fields.map(({ key, label, type, required, options }) => ({ key, label, type, required, options })) };
  }, false);

  /** Public: submit. Same-origin only (the form page sends the request header); honeypot + rate limit. */
  route("POST", "/api/public/forms/:id", async (ctx) => {
    const f = crm.store.forms.get(ctx.params.id);
    if (!f || !f.active) throw httpError(404, "This form isn't available");
    if (!publicLimit(ctx.req, f.id)) throw httpError(429, "Too many submissions. Please try again in a minute.");
    const answers = (ctx.body.answers && typeof ctx.body.answers === "object") ? ctx.body.answers : {};
    // Bots fill every field, including this hidden one; quietly accept and drop.
    if (String(ctx.body.website ?? "").trim()) return { ok: true, message: f.successMessage };
    let result;
    try {
      result = await submitForm(crm, f, answers, { referrer: typeof ctx.body.referrer === "string" ? ctx.body.referrer : undefined });
    } catch (err) {
      if (err instanceof SpectreError && err.code === "opted_out") return { ok: true, message: err.message };
      throw err;
    }
    if (result.created) await emit(f.workspace, { type: "contact.created", contactId: result.contact.id });
    for (const t of result.addedTags) await emit(f.workspace, { type: "tag.added", contactId: result.contact.id, tag: t });
    await emit(f.workspace, { type: "form.submitted", contactId: result.contact.id, formId: f.id });
    return { ok: true, message: f.successMessage };
  }, false);

  /* ---------------- Calendars and booking ---------------- */

  const bookingLimit = limiter(6, 60_000);

  route("GET", "/api/crm/calendars", (ctx) => {
    const ws = ctx.user.workspace;
    const now = crm.now().toISOString();
    const appts = crm.list("appointments", ws);
    return crm.list("calendars", ws).sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({
      ...c, upcoming: appts.filter((a) => a.calendarId === c.id && a.status === "booked" && a.start >= now).length,
    }));
  });
  route("POST", "/api/crm/calendars", (ctx) => createCalendar(crm, ctx.user.workspace, ctx.user.account.cid, ctx.body));
  route("PATCH", "/api/crm/calendars/:id", (ctx) => updateCalendar(crm, ctx.user.workspace, ctx.user.account.cid, ctx.params.id, ctx.body));

  route("GET", "/api/crm/appointments", (ctx) => {
    const ws = ctx.user.workspace;
    const from = ctx.query.get("from") ?? crm.now().toISOString().slice(0, 10);
    const cals = new Map(crm.list("calendars", ws).map((c) => [c.id, c.name]));
    return crm.list("appointments", ws).filter((a) => a.start >= from).sort((a, b) => a.start.localeCompare(b.start)).slice(0, 200)
      .map((a) => ({ ...a, calendar: cals.get(a.calendarId), contactName: crm.store.contacts.get(a.contactId)?.name }));
  });
  route("POST", "/api/crm/appointments/:id/cancel", (ctx) => cancelAppointment(crm, ctx.user.workspace, ctx.user.account.cid, ctx.params.id));

  const publicCalendar = (id: string) => {
    const c = crm.store.calendars.get(id);
    if (!c || !c.active) throw httpError(404, "This booking page isn't available");
    return c;
  };

  /** Public: calendar details and open times. Times are UTC; the page shows them in the visitor's zone. */
  route("GET", "/api/public/calendars/:id", (ctx) => {
    const c = publicCalendar(ctx.params.id);
    const from = ctx.query.get("from") ? new Date(String(ctx.query.get("from"))) : undefined;
    const days = Math.max(1, Math.min(31, Number(ctx.query.get("days") ?? 14) || 14));
    return {
      id: c.id, name: c.name, description: c.description, durationMin: c.durationMin, timezone: c.timezone,
      slots: availableSlots(c, crm.list("appointments", c.workspace), crm.now(), { from: from && !Number.isNaN(from.getTime()) ? from : undefined, days }),
    };
  }, false);

  route("POST", "/api/public/calendars/:id/book", async (ctx) => {
    const c = publicCalendar(ctx.params.id);
    if (!bookingLimit(ctx.req, c.id)) throw httpError(429, "Too many attempts. Please try again in a minute.");
    if (String(ctx.body.website ?? "").trim()) throw httpError(400, "Couldn't book that time");
    const r = await book(crm, c, { start: ctx.body.start, name: ctx.body.name, email: ctx.body.email, phone: ctx.body.phone, notes: ctx.body.notes });
    if (r.created) await emit(c.workspace, { type: "contact.created", contactId: r.contact.id });
    for (const t of r.addedTags) await emit(c.workspace, { type: "tag.added", contactId: r.contact.id, tag: t });
    await emit(c.workspace, { type: "appointment.booked", contactId: r.contact.id, calendarId: c.id, appointmentId: r.appointment.id });
    return { ok: true, start: r.appointment.start, end: r.appointment.end, name: c.name, ics: icsFor(c, r.appointment) };
  }, false);
}
