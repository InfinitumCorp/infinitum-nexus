import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./test-harness.ts";
import type { OutgoingMessage, MessageProvider } from "../core/messaging.ts";

describe("+SPCTR automation triggers: invoice paid, review rated", () => {
  let h: Awaited<ReturnType<typeof harness>>;
  let me: { cookie: string; cid: string };
  const sms: OutgoingMessage[] = [];
  const smsProvider: MessageProvider = { name: "test-sms", channel: "sms", send: async (m) => { sms.push(m); return { providerId: `s${sms.length}` }; } };
  const tagsOf = async (id: string) => (await h.call("GET", "/api/crm/contacts", undefined, me.cookie)).body.contacts.find((c: { id: string }) => c.id === id).tags ?? [];
  const flow = (name: string, trigger: Record<string, unknown>, tag: string) => h.call("POST", "/api/crm/workflows", { name, trigger, steps: [{ type: "add_tag", tag }] }, me.cookie);
  let ana = "";
  let ben = "";

  before(async () => {
    h = await harness({ providers: { sms: smsProvider } });
    me = await h.signUp("tess");
    ana = (await h.call("POST", "/api/contacts", { name: "Ana Petrova", phone: "+1 415 555 0101" }, me.cookie)).body.id;
    ben = (await h.call("POST", "/api/contacts", { name: "Ben Ode", phone: "+1 415 555 0102" }, me.cookie)).body.id;
  });
  after(() => h.close());

  it("validates the rating range", async () => {
    for (const t of [{ minRating: 0 }, { maxRating: 6 }, { minRating: 4, maxRating: 2 }, { minRating: 2.5 }]) {
      assert.equal((await flow("x", { type: "review.rated", ...t }, "x")).status, 400, JSON.stringify(t));
    }
    const ok = await flow("Promoters", { type: "review.rated", minRating: 5 }, "promoter");
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.trigger, { type: "review.rated", minRating: 5 });
    await flow("Detractors", { type: "review.rated", maxRating: 3 }, "detractor");
  });

  it("a paid invoice starts its automation once", async () => {
    await flow("Paid", { type: "invoice.paid" }, "customer");
    const inv = (await h.call("POST", "/api/crm/invoices", { contactId: ana, items: [{ description: "Setup", unitCents: 10000 }] }, me.cookie)).body;
    await h.call("POST", `/api/crm/invoices/${inv.id}/send`, { channel: "sms" }, me.cookie);
    assert.deepEqual(await tagsOf(ana), []);
    await h.call("POST", `/api/crm/invoices/${inv.id}/status`, { status: "paid" }, me.cookie);
    assert.deepEqual(await tagsOf(ana), ["customer"]);
    await h.call("POST", `/api/crm/contacts/${ana}/tags`, { remove: ["customer"] }, me.cookie);
    await h.call("POST", `/api/crm/invoices/${inv.id}/status`, { status: "paid" }, me.cookie);
    assert.deepEqual(await tagsOf(ana), [], "marking paid again doesn't re-run it");
  });

  it("the first rating starts the matching automation", async () => {
    await h.call("PUT", "/api/crm/reviews/settings", { businessName: "Northwind", reviewUrl: "https://g.page/r/northwind/review" }, me.cookie);
    await h.call("POST", "/api/crm/reviews/request", { contactIds: [ana, ben], channel: "sms" }, me.cookie);
    const token = (name: string) => sms.find((m) => m.body.startsWith(`Hi ${name}`) && m.body.includes("review.html"))!.body.match(/t=([A-Za-z0-9_-]+)/)![1]!;
    const r = await h.call("POST", `/api/public/reviews/${token("Ana")}`, { rating: 5 });
    assert.equal(r.status, 200);
    assert.equal(r.body.rated, undefined, "the public response doesn't echo internal details");
    await h.call("POST", `/api/public/reviews/${token("Ben")}`, { rating: 2 });
    assert.deepEqual(await tagsOf(ana), ["promoter"]);
    assert.deepEqual(await tagsOf(ben), ["detractor"]);
    await h.call("POST", `/api/public/reviews/${token("Ben")}`, { rating: 5 });
    assert.deepEqual(await tagsOf(ben), ["detractor"], "changing the rating later doesn't start more automations");
  });
});
