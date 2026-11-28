import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./test-harness.ts";

describe("+SPCTR message templates", () => {
  let h: Awaited<ReturnType<typeof harness>>;
  let me: { cookie: string; cid: string };
  before(async () => { h = await harness(); me = await h.signUp("tia"); });
  after(() => h.close());

  it("validates, saves, lists by channel, edits and deletes", async () => {
    assert.equal((await h.call("POST", "/api/crm/templates", { channel: "sms", body: "x" }, me.cookie)).status, 400);
    assert.equal((await h.call("POST", "/api/crm/templates", { name: "x", channel: "fax", body: "x" }, me.cookie)).status, 400);
    assert.equal((await h.call("POST", "/api/crm/templates", { name: "x", channel: "sms", body: "  " }, me.cookie)).status, 400);
    const e = await h.call("POST", "/api/crm/templates", { name: "Welcome", subject: "Welcome, {{first_name}}", body: "Hi {{first_name}}, glad you're here." }, me.cookie);
    assert.equal(e.status, 200, JSON.stringify(e.body));
    assert.equal(e.body.channel, "email");
    const s = await h.call("POST", "/api/crm/templates", { name: "Appointment reminder", channel: "sms", subject: "ignored", body: "See you tomorrow, {{first_name}}!" }, me.cookie);
    assert.equal(s.body.subject, undefined, "SMS has no subject");
    assert.deepEqual((await h.call("GET", "/api/crm/templates", undefined, me.cookie)).body.map((t: { name: string }) => t.name), ["Appointment reminder", "Welcome"]);
    assert.deepEqual((await h.call("GET", "/api/crm/templates?channel=sms", undefined, me.cookie)).body.map((t: { name: string }) => t.name), ["Appointment reminder"]);
    const ed = await h.call("PATCH", `/api/crm/templates/${e.body.id}`, { body: "Hello {{first_name}}!" }, me.cookie);
    assert.deepEqual([ed.body.name, ed.body.subject, ed.body.body], ["Welcome", "Welcome, {{first_name}}", "Hello {{first_name}}!"]);
    const ledger = JSON.stringify((await h.ledger.entries()).map((x) => x.payload));
    assert.ok(!ledger.includes("glad you're here") && !ledger.includes("Hello {{first_name}}"), "template text stays off the ledger");
    assert.equal((await h.call("DELETE", `/api/crm/templates/${s.body.id}`, undefined, me.cookie)).status, 200);
    assert.equal((await h.call("GET", `/api/crm/templates/${s.body.id}`, undefined, me.cookie)).status, 404);
  });

  it("keeps templates to their workspace", async () => {
    const id = (await h.call("GET", "/api/crm/templates", undefined, me.cookie)).body[0].id;
    const sam = await h.signUp("sam");
    assert.deepEqual((await h.call("GET", "/api/crm/templates", undefined, sam.cookie)).body, []);
    for (const [m, b] of [["GET", undefined], ["PATCH", { name: "mine" }], ["DELETE", undefined]] as const) {
      assert.equal((await h.call(m, `/api/crm/templates/${id}`, b, sam.cookie)).status, 404, m);
    }
  });
});
