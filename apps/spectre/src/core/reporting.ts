/**
 * Grow reporting: what marketing and sales produced over a period, compared with the period before.
 * Counts only; no message text, answers or tokens leave the store.
 */
import type { SpectreCRM } from "./crm.ts";

const DAY = 86_400_000;
export const REPORT_PERIODS = [7, 30, 90] as const;

export function growthReport(crm: SpectreCRM, ws: string, days: number) {
  if (!REPORT_PERIODS.includes(days as (typeof REPORT_PERIODS)[number])) days = 30;
  const now = crm.now().getTime();
  const from = now - days * DAY;
  const prevFrom = from - days * DAY;
  const inP = (iso: string | undefined) => { const t = iso ? Date.parse(iso) : NaN; return t >= from && t <= now; };
  const inPrev = (iso: string | undefined) => { const t = iso ? Date.parse(iso) : NaN; return t >= prevFrom && t < from; };
  const both = <T>(rows: T[], at: (r: T) => string | undefined) => ({ now: rows.filter((r) => inP(at(r))).length, before: rows.filter((r) => inPrev(at(r))).length });

  const contacts = crm.list("contacts", ws);
  const submissions = crm.list("submissions", ws);
  const appointments = crm.list("appointments", ws);
  const messages = crm.list("messages", ws);
  const deals = crm.list("deals", ws);
  const reviews = crm.list("reviewRequests", ws);
  const invoices = crm.list("invoices", ws);
  const forms = new Map(crm.list("forms", ws).map((f) => [f.id, f.name]));

  const won = deals.filter((d) => d.stage === "won");
  const wonNow = won.filter((d) => inP(d.stageEnteredAt));
  const lostNow = deals.filter((d) => d.stage === "lost" && inP(d.stageEnteredAt)).length;
  const rated = reviews.filter((r) => r.rating !== undefined && inP(r.ratedAt));
  const paid = new Map<string, number>();
  for (const i of invoices) if (i.status === "paid" && inP(i.paidAt)) paid.set(i.currency, (paid.get(i.currency) ?? 0) + i.totalCents);

  const sources = new Map<string, number>();
  for (const c of contacts) {
    if (!inP(c.createdAt)) continue;
    const src = !c.source || c.source === "manual" ? "Added by hand" : c.source;
    sources.set(src, (sources.get(src) ?? 0) + 1);
  }
  const byForm = new Map<string, number>();
  for (const s of submissions) if (inP(s.at)) byForm.set(s.formId, (byForm.get(s.formId) ?? 0) + 1);

  // One bar per day (7 / 30) or per week (90): new contacts.
  const bucket = days === 90 ? 7 : 1;
  const series = Array.from({ length: Math.ceil(days / bucket) }, (_, i) => ({ start: new Date(from + i * bucket * DAY).toISOString().slice(0, 10), contacts: 0 }));
  for (const c of contacts) {
    const t = Date.parse(c.createdAt);
    if (t >= from && t <= now) series[Math.min(series.length - 1, Math.floor((t - from) / (bucket * DAY)))]!.contacts++;
  }

  const out = messages.filter((m) => m.direction === "out" && m.channel !== "note");
  return {
    days,
    from: new Date(from).toISOString(),
    to: new Date(now).toISOString(),
    totals: {
      newContacts: both(contacts, (c) => c.createdAt),
      formSubmissions: both(submissions, (s) => s.at),
      appointmentsBooked: both(appointments.filter((a) => a.status === "booked"), (a) => a.createdAt),
      messagesSent: both(out.filter((m) => m.status === "sent"), (m) => m.at),
      repliesReceived: both(messages.filter((m) => m.direction === "in"), (m) => m.at),
      dealsWon: both(won, (d) => d.stageEnteredAt),
      reviewRequests: both(reviews, (r) => r.sentAt),
    },
    wonValue: wonNow.reduce((s, d) => s + (d.amount || 0), 0),
    winRate: wonNow.length + lostNow ? Math.round((wonNow.length / (wonNow.length + lostNow)) * 100) : null,
    averageRating: rated.length ? Math.round((rated.reduce((s, r) => s + r.rating!, 0) / rated.length) * 10) / 10 : null,
    invoicesPaid: [...paid].map(([currency, cents]) => ({ currency, cents })),
    sources: [...sources].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count).slice(0, 10),
    forms: [...byForm].map(([id, count]) => ({ name: forms.get(id) ?? "Deleted form", count })).sort((a, b) => b.count - a.count).slice(0, 10),
    series,
  };
}
