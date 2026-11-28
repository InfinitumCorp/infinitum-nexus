import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./test-harness.ts";
import type { OutgoingMessage, MessageProvider } from "../core/messaging.ts";

describe("+SPCTR campaigns", () => {
  let h: Awaited<ReturnType<typeof harness>>;
  let me: { cookie: string; cid: string };
  const sms: OutgoingMessage[] = [];
  const smsProvider: MessageProvider = { name: "test-sms", channel: "sms", send: async (m) => { sms.push(m); return { providerId: `s${sms.length}` }; } };
  const SECRET = "cron-secret-for-tests";
  const ids: Record<string, string> = {};

  before(async () => {
    h = await harness({ providers: { sms: smsProvider }, cronSecret: SECRET });
    me = await h.signUp("mara");
    const add = async (name: string, extra: Record<string, unknown>, tags: string[]) => {
      const c = (await h.call("POST", "/api/contacts", { name, ...extra }, me.cookie)).body;
      if (tags.length) await h.call("POST", `/api/crm/contacts/${c.id}/tags`, { add: tags }, me.cookie);
      ids[name] = c.id;
    };
    await add("Ana Petrova", { email: "ana@a.example", phone: "+1 415 555 0101" }, ["vip"]);
    await add("Ben Ode", { email: "ben@b.example" }, ["vip"]);
    await add("Cy Lim", { phone: "+1 415 555 0103" }, ["vip", "webinar"]);
    await add("Dee Fox", { email: "dee@d.example", phone: "+1 415 555 0104" }, ["webinar"]);
    await add("Eve Stone", { email: "eve@e.example", phone: "+1 415 555 0105" }, ["vip"]);
    await h.call("POST", `/api/contacts/${ids["Eve Stone"]}/opt-out`, {}, me.cookie);
  });
  after(() => h.close());

  it("validates and previews the audience", async () => {
    assert.equal((await h.call("POST", "/api/crm/campaigns", { name: "x", channel: "email", body: "hi" }, me.cookie)).status, 400, "email needs a subject");
    assert.equal((await h.call("POST", "/api/crm/campaigns", { name: "x", channel: "fax", body: "hi" }, me.cookie)).status, 400);
    assert.equal((await h.call("POST", "/api/crm/campaigns", { name: "x", channel: "sms", body: "hi", audience: { listId: "sl_nope" } }, me.cookie)).status, 400);
    const p = await h.call("POST", "/api/crm/campaigns/preview", { channel: "sms", audience: { tags: ["vip"] } }, me.cookie);
    assert.equal(p.status, 200, JSON.stringify(p.body));
    // vip: Ana (phone), Ben (no phone), Cy (phone). Opting out erased Eve's details, tags included.
    assert.deepEqual([p.body.total, p.body.noAddress, p.body.optedOut], [2, 1, 0]);
    assert.deepEqual(p.body.sample.sort(), ["Ana Petrova", "Cy Lim"]);
  });

  it("sends an SMS to the audience once, skipping missing numbers and never an opt-out", async () => {
    const c = await h.call("POST", "/api/crm/campaigns", { name: "VIP launch", channel: "sms", body: "Hi {{first_name}}, early access is open.", audience: { tags: ["vip"] } }, me.cookie);
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(c.body.status, "draft");
    const s = await h.call("POST", `/api/crm/campaigns/${c.body.id}/send`, {}, me.cookie);
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(s.body.status, "sent");
    assert.deepEqual(s.body.stats, { recipients: 2, sent: 2, drafted: 0, failed: 0, skipped: 1 });
    assert.deepEqual(sms.map((m) => m.body).sort(), ["Hi Ana, early access is open.", "Hi Cy, early access is open."]);
    assert.ok(!sms.some((m) => m.to.endsWith("0105")), "never messages someone who opted out");
    assert.equal((await h.call("POST", `/api/crm/campaigns/${c.body.id}/send`, {}, me.cookie)).status, 400, "a campaign sends once");
    assert.equal((await h.call("PATCH", `/api/crm/campaigns/${c.body.id}`, { body: "changed" }, me.cookie)).status, 400);
    const thread = await h.call("GET", `/api/crm/conversations/${ids["Ana Petrova"]}`, undefined, me.cookie);
    assert.equal(thread.body.messages.at(-1).body, "Hi Ana, early access is open.");
    assert.ok(!JSON.stringify((await h.ledger.entries()).map((e) => e.payload)).includes("early access"), "text stays off the ledger");
  });

  it("emails a smart list as drafts when no email provider is connected", async () => {
    const list = (await h.call("POST", "/api/crm/lists", { name: "Webinar", filter: { tags: ["webinar"] } }, me.cookie)).body;
    const c = (await h.call("POST", "/api/crm/campaigns", { name: "Replay", channel: "email", subject: "The replay, {{first_name}}", body: "Here it is.", audience: { listId: list.id } }, me.cookie)).body;
    const s = await h.call("POST", `/api/crm/campaigns/${c.id}/send`, {}, me.cookie);
    assert.deepEqual(s.body.stats, { recipients: 1, sent: 0, drafted: 1, failed: 0, skipped: 1 }); // Dee has email; Cy has none
    const thread = await h.call("GET", `/api/crm/conversations/${ids["Dee Fox"]}`, undefined, me.cookie);
    assert.equal(thread.body.messages.at(-1).subject, "The replay, Dee");
  });

  it("schedules, reschedules, cancels, and sends on time through the scheduler", async () => {
    const at = new Date(h.crm.now().getTime() + 3_600_000).toISOString();
    const c = (await h.call("POST", "/api/crm/campaigns", { name: "Tomorrow", channel: "sms", body: "Reminder", audience: { tags: ["webinar"] }, scheduledAt: at }, me.cookie)).body;
    assert.equal(c.status, "scheduled");
    const cron = () => h.call("POST", "/api/cron/automations", {}, undefined, { authorization: `Bearer ${SECRET}` });
    assert.equal((await cron()).body.campaigns, 0, "not yet");
    const other = (await h.call("POST", "/api/crm/campaigns", { name: "Never", channel: "sms", body: "x", scheduledAt: at }, me.cookie)).body;
    assert.equal((await h.call("PATCH", `/api/crm/campaigns/${other.id}`, { status: "cancelled" }, me.cookie)).body.status, "cancelled");
    const before = sms.length;
    h.advance(3_700_000);
    assert.equal((await cron()).body.campaigns, 1);
    const done = (await h.call("GET", `/api/crm/campaigns/${c.id}`, undefined, me.cookie)).body;
    assert.equal(done.status, "sent");
    assert.equal(sms.length, before + 2, "Cy and Dee");
    assert.equal((await h.call("GET", `/api/crm/campaigns/${other.id}`, undefined, me.cookie)).body.status, "cancelled");
  });

  it("keeps campaigns to their workspace", async () => {
    const list = (await h.call("GET", "/api/crm/campaigns", undefined, me.cookie)).body;
    assert.equal(list.length, 4);
    const sam = await h.signUp("sam");
    assert.equal((await h.call("GET", "/api/crm/campaigns", undefined, sam.cookie)).body.length, 0);
    assert.equal((await h.call("GET", `/api/crm/campaigns/${list[0].id}`, undefined, sam.cookie)).status, 404);
    assert.equal((await h.call("POST", `/api/crm/campaigns/${list[0].id}/send`, {}, sam.cookie)).status, 404);
    assert.equal((await h.call("DELETE", `/api/crm/campaigns/${list[0].id}`, undefined, sam.cookie)).status, 404);
    assert.equal((await h.call("DELETE", `/api/crm/campaigns/${list[0].id}`, undefined, me.cookie)).status, 200);
  });
});
