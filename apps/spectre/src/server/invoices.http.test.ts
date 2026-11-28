import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./test-harness.ts";
import { totals } from "../core/invoices.ts";
import type { OutgoingMessage, MessageProvider } from "../core/messaging.ts";

describe("invoice totals", () => {
  it("adds lines in cents and rounds tax half up", () => {
    assert.deepEqual(totals([{ description: "a", quantity: 3, unitCents: 1999 }, { description: "b", quantity: 0.5, unitCents: 1001 }], 20), { subtotalCents: 6498, taxCents: 1300, totalCents: 7798 });
    assert.deepEqual(totals([{ description: "a", quantity: 1, unitCents: 5 }], 10), { subtotalCents: 5, taxCents: 1, totalCents: 6 });
  });
});

describe("+SPCTR invoices", () => {
  let h: Awaited<ReturnType<typeof harness>>;
  let me: { cookie: string; cid: string };
  const sms: OutgoingMessage[] = [];
  const smsProvider: MessageProvider = { name: "test-sms", channel: "sms", send: async (m) => { sms.push(m); return { providerId: `s${sms.length}` }; } };
  let ana = "";
  let deal = "";
  let inv: { id: string; number: string } = { id: "", number: "" };
  const tokenFrom = (body: string) => body.match(/invoice\.html\?t=([A-Za-z0-9_-]+)/)![1]!;

  before(async () => {
    h = await harness({ providers: { sms: smsProvider } });
    me = await h.signUp("ivy");
    const co = (await h.call("POST", "/api/companies", { name: "Acme Rail" }, me.cookie)).body;
    ana = (await h.call("POST", "/api/contacts", { name: "Ana Petrova", companyId: co.id, email: "ana@a.example", phone: "+1 415 555 0101" }, me.cookie)).body.id;
    deal = (await h.call("POST", "/api/deals", { companyId: co.id, name: "Pilot", amount: 5000, closeDate: "2026-12-20", contactIds: [ana] }, me.cookie)).body.id;
  });
  after(() => h.close());

  it("validates settings and invoices", async () => {
    assert.equal((await h.call("PUT", "/api/crm/invoices/settings", { currency: "XYZ" }, me.cookie)).status, 400);
    assert.equal((await h.call("PUT", "/api/crm/invoices/settings", { paymentUrl: "http://pay.example" }, me.cookie)).status, 400);
    const s = await h.call("PUT", "/api/crm/invoices/settings", { from: "Northwind LLC\n1 Main St", currency: "EUR", paymentUrl: "https://buy.stripe.com/test_123" }, me.cookie);
    assert.equal(s.status, 200, JSON.stringify(s.body));
    const bad = [
      { contactId: "ct_nope", items: [{ description: "x", unitCents: 100 }] },
      { contactId: ana, items: [] },
      { contactId: ana, items: [{ description: "", unitCents: 100 }] },
      { contactId: ana, items: [{ description: "x", unitCents: 10.5 }] },
      { contactId: ana, items: [{ description: "x", unitCents: -1 }] },
      { contactId: ana, items: [{ description: "x", quantity: 0, unitCents: 100 }] },
      { contactId: ana, items: [{ description: "x", unitCents: 100 }], taxRate: 120 },
      { contactId: ana, items: [{ description: "x", unitCents: 100 }], issueDate: "2026-12-10", dueDate: "2026-12-01" },
      { contactId: ana, items: [{ description: "x", unitCents: 100 }], dueDate: "next week" },
    ];
    for (const b of bad) assert.equal((await h.call("POST", "/api/crm/invoices", b, me.cookie)).status, b.contactId === "ct_nope" ? 404 : 400, JSON.stringify(b));
  });

  it("creates numbered drafts with totals and the workspace defaults", async () => {
    const r = await h.call("POST", "/api/crm/invoices", {
      contactId: ana, dealId: deal, taxRate: 20, issueDate: "2026-11-28", dueDate: "2026-12-12",
      items: [{ description: "Setup", quantity: 1, unitCents: 150000 }, { description: "Seats", quantity: 12, unitCents: 2500 }],
    }, me.cookie);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    inv = r.body;
    assert.deepEqual([r.body.number, r.body.status, r.body.currency, r.body.subtotalCents, r.body.taxCents, r.body.totalCents, r.body.paymentUrl],
      ["INV-0001", "draft", "EUR", 180000, 36000, 216000, "https://buy.stripe.com/test_123"]);
    const second = await h.call("POST", "/api/crm/invoices", { contactId: ana, items: [{ description: "Extra", unitCents: 100 }] }, me.cookie);
    assert.equal(second.body.number, "INV-0002");
    assert.equal(second.body.dueDate, new Date(Date.parse(`${second.body.issueDate}T00:00:00Z`) + 14 * 86_400_000).toISOString().slice(0, 10), "due in 14 days by default");
    const edited = await h.call("PATCH", `/api/crm/invoices/${second.body.id}`, { items: [{ description: "Extra", quantity: 2, unitCents: 100 }] }, me.cookie);
    assert.equal(edited.body.totalCents, 200);
    assert.equal((await h.call("GET", `/api/crm/invoices/${inv.id}/link`, undefined, me.cookie)).status, 400, "drafts have no customer link yet");
  });

  it("sends a link the customer can open; drafts aren't public", async () => {
    const s = await h.call("POST", `/api/crm/invoices/${inv.id}/send`, { channel: "sms" }, me.cookie);
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.deepEqual([s.body.delivery, s.body.invoice.status], ["sent", "sent"]);
    assert.equal(s.body.invoice.token, undefined, "the token isn't returned");
    assert.match(sms[0]!.body, /^Hi Ana, here is invoice INV-0001 for €2,160\.00, due 2026-12-12: http:\/\/localhost\/invoice\.html\?t=/);
    const t = tokenFrom(sms[0]!.body);
    const p = await h.call("GET", `/api/public/invoices/${t}`);
    assert.equal(p.status, 200);
    assert.deepEqual([p.body.number, p.body.totalCents, p.body.paymentUrl, p.body.to], ["INV-0001", 216000, "https://buy.stripe.com/test_123", ["Ana Petrova", "Acme Rail", "ana@a.example"]]);
    assert.equal(p.body.from, "Northwind LLC\n1 Main St");
    assert.equal((await h.call("GET", `/api/public/invoices/${"x".repeat(24)}`)).status, 404);
    const draft = h.crm.list("invoices", me.cid).find((i) => i.number === "INV-0002")!;
    assert.equal((await h.call("GET", `/api/public/invoices/${draft.token}`)).status, 404, "a draft isn't public");
    assert.equal((await h.call("PATCH", `/api/crm/invoices/${inv.id}`, { taxRate: 0 }, me.cookie)).status, 400, "a sent invoice is locked");
    const d = (await h.call("GET", "/api/crm/invoices", undefined, me.cookie)).body;
    assert.ok(d.invoices.find((i: any) => i.id === inv.id).viewedAt, "opening counts as viewed");
    assert.deepEqual(d.totals.EUR, { outstandingCents: 216000, overdueCents: 0, paidCents: 0 });
    assert.ok(!JSON.stringify(d).includes(t), "the dashboard never shows tokens");
  });

  it("marks paid (logged on the deal), hides the pay button, and won't void a paid invoice", async () => {
    const t = tokenFrom(sms[0]!.body);
    const paid = await h.call("POST", `/api/crm/invoices/${inv.id}/status`, { status: "paid" }, me.cookie);
    assert.equal(paid.body.status, "paid");
    assert.ok(h.crm.list("activities", me.cid).some((a) => a.summary === "Invoice INV-0001 paid" && a.dealId === deal));
    assert.equal((await h.call("GET", `/api/public/invoices/${t}`)).body.paymentUrl, undefined);
    assert.equal((await h.call("POST", `/api/crm/invoices/${inv.id}/status`, { status: "void" }, me.cookie)).status, 400);
    assert.equal((await h.call("POST", `/api/crm/invoices/${inv.id}/send`, {}, me.cookie)).status, 400);
    h.advance(30 * 86_400_000);
    const d = (await h.call("GET", "/api/crm/invoices", undefined, me.cookie)).body;
    assert.deepEqual(d.totals.EUR, { outstandingCents: 0, overdueCents: 0, paidCents: 216000 });
    const ledger = JSON.stringify((await h.ledger.entries()).map((e) => e.payload));
    assert.ok(!ledger.includes("Seats") && !ledger.includes(t), "line items and tokens stay off the ledger");
  });

  it("flags overdue invoices and keeps invoices to their workspace", async () => {
    const draft = h.crm.list("invoices", me.cid).find((i) => i.number === "INV-0002")!;
    await h.call("POST", `/api/crm/invoices/${draft.id}/send`, { channel: "email" }, me.cookie);
    const d = (await h.call("GET", "/api/crm/invoices", undefined, me.cookie)).body;
    assert.equal(d.invoices.find((i: any) => i.number === "INV-0002").status, "sent", "with no email provider the invoice still opens (its link can be shared) and the email waits as a draft");
    h.advance(20 * 86_400_000);
    const later = (await h.call("GET", "/api/crm/invoices", undefined, me.cookie)).body;
    assert.equal(later.invoices.find((i: any) => i.number === "INV-0002").overdue, true);
    assert.equal(later.totals.EUR.overdueCents, 200);
    const sam = await h.signUp("sam");
    assert.equal((await h.call("GET", "/api/crm/invoices", undefined, sam.cookie)).body.invoices.length, 0);
    for (const [m, p] of [["GET", `/api/crm/invoices/${inv.id}`], ["POST", `/api/crm/invoices/${inv.id}/status`], ["POST", `/api/crm/invoices/${inv.id}/send`], ["GET", `/api/crm/invoices/${inv.id}/link`]] as const) {
      assert.equal((await h.call(m, p, m === "POST" ? { status: "void" } : undefined, sam.cookie)).status, 404, p);
    }
    assert.equal((await h.call("POST", "/api/crm/invoices", { contactId: ana, items: [{ description: "x", unitCents: 1 }] }, sam.cookie)).status, 404, "can't bill another workspace's contact");
  });
});
