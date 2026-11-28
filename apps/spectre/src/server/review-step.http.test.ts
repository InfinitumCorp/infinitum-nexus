import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./test-harness.ts";
import type { OutgoingMessage, MessageProvider } from "../core/messaging.ts";

describe("+SPCTR automation step: request a review", () => {
  let h: Awaited<ReturnType<typeof harness>>;
  let me: { cookie: string; cid: string };
  const sms: OutgoingMessage[] = [];
  const smsProvider: MessageProvider = { name: "test-sms", channel: "sms", send: async (m) => { sms.push(m); return { providerId: `s${sms.length}` }; } };
  let co = "";
  const won = async (name: string, phone?: string) => {
    h.advance(60_000);
    const c = (await h.call("POST", "/api/contacts", { name, companyId: co, phone }, me.cookie)).body.id;
    const d = (await h.call("POST", "/api/deals", { companyId: co, name: `${name} deal`, amount: 100, closeDate: "2026-12-20", contactIds: [c] }, me.cookie)).body.id;
    const r = await h.call("POST", `/api/deals/${d}/stage`, { stage: "won" }, me.cookie);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return c;
  };
  let wfId = "";
  const lastLog = async () => JSON.stringify((await h.call("GET", `/api/crm/workflows/${wfId}/jobs`, undefined, me.cookie)).body[0].log);

  before(async () => {
    h = await harness({ providers: { sms: smsProvider } });
    me = await h.signUp("rae");
    co = (await h.call("POST", "/api/companies", { name: "Acme" }, me.cookie)).body.id;
  });
  after(() => h.close());

  it("a won deal texts the customer a review link once", async () => {
    const wf = await h.call("POST", "/api/crm/workflows", { name: "Ask won customers", trigger: { type: "deal.stage_changed", toStage: "won" }, steps: [{ type: "request_review", channel: "sms" }] }, me.cookie);
    assert.equal(wf.status, 200, JSON.stringify(wf.body));
    assert.deepEqual(wf.body.steps, [{ type: "request_review", channel: "sms" }]);
    wfId = wf.body.id;

    await won("Ana Petrova", "+1 415 555 0101");
    assert.equal(sms.length, 0, "no review link yet, so nothing is sent");
    assert.match(await lastLog(), /Failed: Add your review link first/);

    await h.call("PUT", "/api/crm/reviews/settings", { businessName: "Northwind", reviewUrl: "https://g.page/r/northwind/review" }, me.cookie);
    const ben = await won("Ben Ode", "+1 415 555 0102");
    assert.equal(sms.length, 1);
    assert.match(await lastLog(), /Review request sent by SMS/);
    assert.match(sms[0]!.body, /^Hi Ben, thanks for choosing Northwind! .* http:\/\/localhost\/review\.html\?t=[A-Za-z0-9_-]{24}$/);
    const d = (await h.call("GET", "/api/crm/reviews", undefined, me.cookie)).body;
    assert.deepEqual(d.requests.map((r: { contactId: string }) => r.contactId), [ben]);
  });

  it("skips people without a phone and people asked recently", async () => {
    await won("Cy Lim");
    assert.equal(sms.length, 1, "no phone, no text");
    assert.match(await lastLog(), /Skipped: no phone/);
    // Ben bought again: still inside 30 days, so no second ask.
    const ben = (await h.call("GET", "/api/contacts", undefined, me.cookie)).body.find((c: { name: string }) => c.name === "Ben Ode").id;
    h.advance(60_000);
    const d = (await h.call("POST", "/api/deals", { companyId: co, name: "Ben again", amount: 50, closeDate: "2026-12-21", contactIds: [ben] }, me.cookie)).body.id;
    await h.call("POST", `/api/deals/${d}/stage`, { stage: "won" }, me.cookie);
    assert.equal(sms.length, 1);
    assert.match(await lastLog(), /Skipped: asked in the last 30 days/);
  });
});
