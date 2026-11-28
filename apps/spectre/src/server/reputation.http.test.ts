import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./test-harness.ts";
import type { OutgoingMessage, MessageProvider } from "../core/messaging.ts";

describe("+SPCTR reputation (review requests)", () => {
  let h: Awaited<ReturnType<typeof harness>>;
  let me: { cookie: string; cid: string };
  const sms: OutgoingMessage[] = [];
  const smsProvider: MessageProvider = { name: "test-sms", channel: "sms", send: async (m) => { sms.push(m); return { providerId: `s${sms.length}` }; } };
  const ids: Record<string, string> = {};
  const token = () => sms.at(-1)!.body.match(/review\.html\?t=([A-Za-z0-9_-]+)/)![1]!;
  const pub = (method: string, t: string, body?: unknown) => h.call(method, `/api/public/reviews/${t}`, body);

  before(async () => {
    h = await harness({ providers: { sms: smsProvider } });
    me = await h.signUp("rhea");
    for (const [name, extra] of [["Ana Petrova", { phone: "+1 415 555 0101", email: "ana@a.example" }], ["Ben Ode", { email: "ben@b.example" }], ["Cy Lim", { phone: "+1 415 555 0103" }], ["Eve Stone", { phone: "+1 415 555 0105" }]] as const) {
      ids[name] = (await h.call("POST", "/api/contacts", { name, ...extra }, me.cookie)).body.id;
    }
    await h.call("POST", `/api/contacts/${ids["Eve Stone"]}/opt-out`, {}, me.cookie);
  });
  after(() => h.close());

  it("needs a valid https review link before asking", async () => {
    assert.equal((await h.call("POST", "/api/crm/reviews/request", { contactIds: [ids["Ana Petrova"]], channel: "sms" }, me.cookie)).status, 400);
    assert.equal((await h.call("PUT", "/api/crm/reviews/settings", { businessName: "Northwind", reviewUrl: "http://g.page/r/x" }, me.cookie)).status, 400);
    assert.equal((await h.call("PUT", "/api/crm/reviews/settings", { businessName: "Northwind", reviewUrl: "javascript:alert(1)" }, me.cookie)).status, 400);
    const ok = await h.call("PUT", "/api/crm/reviews/settings", { businessName: "Northwind", reviewUrl: "https://g.page/r/northwind/review" }, me.cookie);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await h.call("GET", "/api/crm/reviews", undefined, me.cookie)).body.settings.businessName, "Northwind");
  });

  it("texts a private link and skips people it shouldn't ask", async () => {
    assert.equal((await h.call("POST", "/api/crm/reviews/request", { contactIds: [ids["Ana Petrova"]], channel: "sms", message: "no link here" }, me.cookie)).status, 400);
    const r = await h.call("POST", "/api/crm/reviews/request", { contactIds: [ids["Ana Petrova"], ids["Ben Ode"], ids["Eve Stone"], "ct_nope"], channel: "sms" }, me.cookie);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.requested, r.body.sent], [1, 1]);
    assert.deepEqual(r.body.skipped.map((s: { reason: string }) => s.reason).sort(), ["no phone", "not found", "opted out"]);
    assert.equal(sms.length, 1);
    assert.match(sms[0]!.body, /^Hi Ana, thanks for choosing Northwind! .* http:\/\/localhost\/review\.html\?t=[A-Za-z0-9_-]{24}$/);
    const again = await h.call("POST", "/api/crm/reviews/request", { contactIds: [ids["Ana Petrova"]], channel: "sms" }, me.cookie);
    assert.equal(again.body.requested, 0, "not asked twice within 30 days");
    assert.match(again.body.skipped[0].reason, /30 days/);
  });

  it("the public page records opens, ratings and clicks, and always offers the public link", async () => {
    assert.equal((await pub("GET", "short")).status, 404);
    assert.equal((await pub("GET", "A".repeat(24))).status, 404);
    const t = token();
    const page = await pub("GET", t);
    assert.equal(page.status, 200);
    assert.deepEqual(page.body, { business: "Northwind", reviewUrl: "https://g.page/r/northwind/review", firstName: "Ana", done: false });
    assert.equal((await pub("POST", t, { rating: 9 })).status, 400);
    const low = await pub("POST", t, { rating: 2 });
    assert.equal(low.body.reviewUrl, "https://g.page/r/northwind/review", "no review gating: a low rating still gets the public link");
    await pub("POST", t, { clicked: true });
    await pub("POST", t, { feedback: "The install was late." });
    const tasks = h.crm.list("activities", me.cid).filter((a) => a.kind === "task");
    assert.equal(tasks.length, 1, "one follow-up task per request");
    assert.match(tasks[0]!.summary, /Follow up on 2★ feedback from Ana Petrova/);
    const d = (await h.call("GET", "/api/crm/reviews", undefined, me.cookie)).body;
    assert.deepEqual(d.stats, { requested: 1, opened: 1, rated: 1, average: 2, clicked: 1, feedback: 1 });
    assert.equal(d.requests[0].feedback, "The install was late.");
    assert.ok(!JSON.stringify(d).includes(t), "the dashboard never shows link tokens");
    const ledger = JSON.stringify((await h.ledger.entries()).map((e) => e.payload));
    assert.ok(!ledger.includes("install was late") && !ledger.includes(t), "feedback and tokens stay off the ledger");
  });

  it("a happy rating creates no task; email requests are drafts without a provider", async () => {
    const r = await h.call("POST", "/api/crm/reviews/request", { contactIds: [ids["Cy Lim"]], channel: "sms" }, me.cookie);
    assert.equal(r.body.sent, 1);
    await pub("POST", token(), { rating: 5 });
    assert.equal(h.crm.list("activities", me.cid).filter((a) => a.kind === "task").length, 1);
    const e = await h.call("POST", "/api/crm/reviews/request", { contactIds: [ids["Ben Ode"]], channel: "email" }, me.cookie);
    assert.deepEqual([e.body.requested, e.body.drafted], [1, 1]);
    const thread = await h.call("GET", `/api/crm/conversations/${ids["Ben Ode"]}`, undefined, me.cookie);
    assert.equal(thread.body.messages.at(-1).subject, "How did we do, Ben?");
    assert.equal((await h.call("GET", "/api/crm/reviews", undefined, me.cookie)).body.stats.average, 3.5);
  });

  it("keeps reviews to their workspace", async () => {
    const sam = await h.signUp("sam");
    const d = (await h.call("GET", "/api/crm/reviews", undefined, sam.cookie)).body;
    assert.deepEqual([d.requests.length, d.settings.reviewUrl], [0, undefined]);
    assert.equal((await h.call("POST", "/api/crm/reviews/request", { contactIds: [ids["Cy Lim"]], channel: "sms" }, sam.cookie)).status, 400, "no link set for sam");
    await h.call("PUT", "/api/crm/reviews/settings", { reviewUrl: "https://example.com/r" }, sam.cookie);
    const r = await h.call("POST", "/api/crm/reviews/request", { contactIds: [ids["Cy Lim"]], channel: "sms" }, sam.cookie);
    assert.deepEqual(r.body.skipped, [{ contactId: ids["Cy Lim"], reason: "not found" }]);
  });
});
