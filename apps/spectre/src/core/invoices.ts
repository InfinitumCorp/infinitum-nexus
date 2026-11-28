/**
 * Invoices: line items, tax, a due date, and a public invoice page the customer can open
 * and print. +SPCTR never takes or moves money: the page's Pay button opens the business's
 * own payment link (e.g. a Stripe Payment Link), and someone marks the invoice paid.
 * Amounts are integer cents. Invoice contents stay off the ledger (only number, total, status).
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { SpectreCRM } from "./crm.ts";
import { SpectreError } from "./crm.ts";
import { sendMessage, type Providers } from "./messaging.ts";

export interface InvoiceItem { description: string; quantity: number; unitCents: number }

export interface Invoice {
  id: string;
  workspace: string;
  /** Per-workspace sequence: INV-0001, INV-0002… */
  number: string;
  contactId: string;
  dealId?: string;
  items: InvoiceItem[];
  currency: string;
  /** Percent, e.g. 20 for 20% VAT. */
  taxRate: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  issueDate: string; // YYYY-MM-DD
  dueDate: string; // YYYY-MM-DD
  notes?: string;
  /** The business's own payment page. https only. */
  paymentUrl?: string;
  status: "draft" | "sent" | "paid" | "void";
  token: string;
  sentAt?: string;
  viewedAt?: string;
  paidAt?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface InvoiceSettings {
  id: string; // = workspace
  workspace: string;
  /** Who the invoice is from: name, address, tax id. Free text, a few lines. */
  from: string;
  currency: string;
  paymentUrl?: string;
  updatedAt: string;
}

export const INVOICE_LIMITS = { items: 50, perWorkspace: 5000, maxCents: 100_000_000_00 };
const DAY = 86_400_000;
const CURRENCIES = new Set(["USD", "EUR", "GBP", "RUB", "CAD", "AUD", "CHF", "JPY", "CNY", "INR", "AED", "SGD", "BRL", "MXN", "ZAR", "SEK", "NOK", "DKK", "PLN", "TRY", "KZT"]);

const httpsUrl = (raw: unknown, label: string) => {
  if (raw === undefined || raw === null || raw === "") return undefined;
  let u: URL;
  try { u = new URL(String(raw).trim()); } catch { throw new SpectreError("invalid", `${label} isn't a valid web address`); }
  if (u.protocol !== "https:") throw new SpectreError("invalid", `${label} must start with https://`);
  return u.toString();
};
const isoDate = (raw: unknown, fallback: string) => {
  const s = raw === undefined || raw === "" ? fallback : String(raw);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(`${s}T00:00:00Z`))) throw new SpectreError("invalid", "Dates look like 2026-12-31");
  return s;
};

export function invoiceSettings(crm: SpectreCRM, ws: string): InvoiceSettings {
  return crm.store.invoiceSettings.get(ws) ?? { id: ws, workspace: ws, from: "", currency: "USD", updatedAt: "" };
}

export async function saveInvoiceSettings(crm: SpectreCRM, ws: string, actor: string, raw: Record<string, unknown>) {
  const currency = String(raw.currency ?? "USD").toUpperCase();
  if (!CURRENCIES.has(currency)) throw new SpectreError("invalid", "Pick a supported currency");
  const s: InvoiceSettings = { id: ws, workspace: ws, from: String(raw.from ?? "").trim().slice(0, 600), currency, paymentUrl: httpsUrl(raw.paymentUrl, "The payment link"), updatedAt: crm.now().toISOString() };
  crm.store.invoiceSettings.set(ws, s);
  await crm.record(actor, `invoices:${ws}`, { event: "invoices.settings" });
  return s;
}

/** Totals in cents; tax is rounded half up on the subtotal. */
export function totals(items: InvoiceItem[], taxRate: number) {
  const subtotalCents = items.reduce((s, i) => s + Math.round(i.quantity * i.unitCents), 0);
  const taxCents = Math.round((subtotalCents * taxRate) / 100);
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}

function cleanItems(raw: unknown): InvoiceItem[] {
  const list = Array.isArray(raw) ? raw : [];
  const items = list.slice(0, INVOICE_LIMITS.items + 1).map((r) => {
    const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    const description = String(o.description ?? "").trim().slice(0, 300);
    const quantity = Number(o.quantity ?? 1);
    const unitCents = Number(o.unitCents);
    if (!description) throw new SpectreError("invalid", "Every line needs a description");
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000) throw new SpectreError("invalid", "Quantities are above 0");
    if (!Number.isInteger(unitCents) || unitCents < 0 || unitCents > INVOICE_LIMITS.maxCents) throw new SpectreError("invalid", "Prices are whole cents, 0 or more");
    return { description, quantity: Math.round(quantity * 100) / 100, unitCents };
  });
  if (!items.length) throw new SpectreError("invalid", "Add at least one line");
  if (items.length > INVOICE_LIMITS.items) throw new SpectreError("invalid", `An invoice holds up to ${INVOICE_LIMITS.items} lines`);
  return items;
}

function clean(crm: SpectreCRM, ws: string, raw: Record<string, unknown>, settings: InvoiceSettings) {
  const contact = crm.contact(ws, String(raw.contactId ?? ""));
  if (raw.dealId) crm.deal(ws, String(raw.dealId));
  const items = cleanItems(raw.items);
  const taxRate = Number(raw.taxRate ?? 0);
  if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) throw new SpectreError("invalid", "Tax is a percent from 0 to 100");
  const currency = String(raw.currency ?? settings.currency).toUpperCase();
  if (!CURRENCIES.has(currency)) throw new SpectreError("invalid", "Pick a supported currency");
  const today = crm.now().toISOString().slice(0, 10);
  const issueDate = isoDate(raw.issueDate, today);
  const dueDate = isoDate(raw.dueDate, new Date(Date.parse(`${issueDate}T00:00:00Z`) + 14 * DAY).toISOString().slice(0, 10));
  if (dueDate < issueDate) throw new SpectreError("invalid", "The due date is before the issue date");
  const t = totals(items, taxRate);
  if (t.totalCents > INVOICE_LIMITS.maxCents) throw new SpectreError("invalid", "That total is too large");
  return {
    contactId: contact.id, dealId: raw.dealId ? String(raw.dealId) : undefined, items, taxRate, currency, issueDate, dueDate, ...t,
    notes: String(raw.notes ?? "").trim().slice(0, 2000) || undefined,
    paymentUrl: httpsUrl(raw.paymentUrl, "The payment link") ?? settings.paymentUrl,
  };
}

export async function createInvoice(crm: SpectreCRM, ws: string, actor: string, raw: Record<string, unknown>): Promise<Invoice> {
  const existing = crm.list("invoices", ws);
  if (existing.length >= INVOICE_LIMITS.perWorkspace) throw new SpectreError("invalid", "This workspace has too many invoices");
  const input = clean(crm, ws, raw, invoiceSettings(crm, ws));
  const seq = existing.reduce((m, i) => Math.max(m, Number(i.number.slice(4)) || 0), 0) + 1;
  const at = crm.now().toISOString();
  const inv: Invoice = {
    id: `iv_${randomUUID()}`, workspace: ws, number: `INV-${String(seq).padStart(4, "0")}`, ...input,
    status: "draft", token: randomBytes(18).toString("base64url"), createdBy: actor, createdAt: at, updatedAt: at,
  };
  crm.store.invoices.set(inv.id, inv);
  await crm.record(actor, `invoice:${inv.id}`, { event: "invoice.created", number: inv.number, totalCents: inv.totalCents, currency: inv.currency });
  return inv;
}

export function getInvoice(crm: SpectreCRM, ws: string, id: string): Invoice {
  const inv = crm.store.invoices.get(id);
  if (!inv || inv.workspace !== ws) throw new SpectreError("not_found", "Invoice not found");
  return inv;
}

export async function updateInvoice(crm: SpectreCRM, ws: string, actor: string, id: string, raw: Record<string, unknown>) {
  const inv = getInvoice(crm, ws, id);
  if (inv.status !== "draft") throw new SpectreError("invalid", "Only a draft can be edited. Void it and make a new one.");
  Object.assign(inv, clean(crm, ws, { ...inv, ...raw }, invoiceSettings(crm, ws)), { updatedAt: crm.now().toISOString() });
  await crm.record(actor, `invoice:${inv.id}`, { event: "invoice.updated", totalCents: inv.totalCents });
  return inv;
}

/** Status changes a person makes: paid (with an activity on the person and deal) or void. */
export async function setInvoiceStatus(crm: SpectreCRM, ws: string, actor: string, id: string, status: unknown) {
  const inv = getInvoice(crm, ws, id);
  const now = crm.now().toISOString();
  if (status === "paid") {
    if (inv.status === "void") throw new SpectreError("invalid", "This invoice was voided");
    if (inv.status === "paid") return inv;
    inv.status = "paid";
    inv.paidAt = now;
    await crm.logActivity(ws, actor, { kind: "note", summary: `Invoice ${inv.number} paid`, contactIds: [inv.contactId], dealId: inv.dealId });
  } else if (status === "void") {
    if (inv.status === "paid") throw new SpectreError("invalid", "A paid invoice can't be voided");
    inv.status = "void";
  } else throw new SpectreError("invalid", "Status is paid or void");
  inv.updatedAt = now;
  await crm.record(actor, `invoice:${inv.id}`, { event: `invoice.${inv.status}`, number: inv.number });
  return inv;
}

export async function sendInvoice(crm: SpectreCRM, providers: Providers, ws: string, actor: string, id: string, raw: { channel?: unknown; origin: string }) {
  const inv = getInvoice(crm, ws, id);
  if (inv.status === "void" || inv.status === "paid") throw new SpectreError("invalid", `This invoice is ${inv.status}`);
  const channel = raw.channel === "sms" ? "sms" : "email";
  const link = `${raw.origin.replace(/\/$/, "")}/invoice.html?t=${inv.token}`;
  const amount = money(inv.totalCents, inv.currency);
  const m = await sendMessage(crm, providers, ws, actor, {
    contactId: inv.contactId, channel,
    subject: channel === "email" ? `Invoice ${inv.number} for ${amount}` : undefined,
    body: channel === "email"
      ? `Hi {{first_name}},\n\nHere is invoice ${inv.number} for ${amount}, due ${inv.dueDate}:\n\n${link}\n\nThank you!`
      : `Hi {{first_name}}, here is invoice ${inv.number} for ${amount}, due ${inv.dueDate}: ${link}`,
  });
  if (m.status !== "failed") {
    inv.status = "sent";
    inv.sentAt = crm.now().toISOString();
    inv.updatedAt = inv.sentAt;
  }
  await crm.record(actor, `invoice:${inv.id}`, { event: "invoice.sent", channel, delivery: m.status });
  return { invoice: inv, delivery: m.status, error: m.error };
}

export const money = (cents: number, currency: string) => {
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100); } catch { return `${(cents / 100).toFixed(2)} ${currency}`; }
};

/** What the customer's invoice page shows. Opening it counts as viewed. Drafts aren't public. */
export function publicInvoice(crm: SpectreCRM, token: string) {
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(token)) throw new SpectreError("not_found", "This invoice link isn't valid");
  const inv = [...crm.store.invoices.values()].find((i) => i.token === token);
  if (!inv || inv.status === "draft") throw new SpectreError("not_found", "This invoice link isn't valid");
  inv.viewedAt ??= crm.now().toISOString();
  const c = crm.store.contacts.get(inv.contactId);
  const company = c?.companyId ? crm.store.companies.get(c.companyId)?.name : undefined;
  const s = invoiceSettings(crm, inv.workspace);
  return {
    number: inv.number, status: inv.status, from: s.from, to: [c?.name, company, c?.email].filter(Boolean),
    issueDate: inv.issueDate, dueDate: inv.dueDate, currency: inv.currency, items: inv.items, taxRate: inv.taxRate,
    subtotalCents: inv.subtotalCents, taxCents: inv.taxCents, totalCents: inv.totalCents, notes: inv.notes,
    paymentUrl: inv.status === "sent" ? inv.paymentUrl : undefined, paidAt: inv.paidAt,
  };
}

/** The Invoices page: settings, invoices with names, and totals by currency. */
export function invoiceDashboard(crm: SpectreCRM, ws: string) {
  const names = new Map(crm.list("contacts", ws).map((c) => [c.id, c.name]));
  const today = crm.now().toISOString().slice(0, 10);
  const invoices = crm.list("invoices", ws).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const sums: Record<string, { outstandingCents: number; overdueCents: number; paidCents: number }> = {};
  for (const i of invoices) {
    const s = (sums[i.currency] ??= { outstandingCents: 0, overdueCents: 0, paidCents: 0 });
    if (i.status === "sent") { s.outstandingCents += i.totalCents; if (i.dueDate < today) s.overdueCents += i.totalCents; }
    if (i.status === "paid") s.paidCents += i.totalCents;
  }
  return {
    settings: invoiceSettings(crm, ws),
    totals: sums,
    invoices: invoices.slice(0, 500).map(({ token: _t, ...i }) => ({ ...i, name: names.get(i.contactId) ?? "Removed", overdue: i.status === "sent" && i.dueDate < today })),
  };
}

/** Link to the customer page, for the business to copy (only for invoices that were sent). */
export function invoiceLink(crm: SpectreCRM, ws: string, id: string, origin: string) {
  const inv = getInvoice(crm, ws, id);
  if (inv.status === "draft") throw new SpectreError("invalid", "Send the invoice first");
  return { url: `${origin.replace(/\/$/, "")}/invoice.html?t=${inv.token}` };
}
