import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./test-harness.ts";

const FORM = {
  name: "Book a demo",
  headline: "See +SPCTR in action",
  tags: ["Demo Request", "website"],
  fields: [
    { key: "name", label: "Your name", type: "text", required: true, map: "name" },
    { key: "email", label: "Work email", type: "email", required: true, map: "email" },
    { key: "company", label: "Company", type: "text", map: "company" },
    { key: "team", label: "Team size", type: "select", options: ["1-10", "11-50", "51+"], map: "field:team_size" },
  ],
};

describe("+SPCTR contacts upgrade and forms", () => {
  let h: Awaited<ReturnType<typeof harness>>;
  let me: { cookie: string; cid: string };
  let formId: string;
  before(async () => { h = await harness(); me = await h.signUp("alex"); });
  after(() => h.close());

  it("validates forms in the builder", async () => {
    const noContact = await h.call("POST", "/api/crm/forms", { name: "X", fields: [{ key: "name", label: "Name", map: "name" }] }, me.cookie);
    assert.equal(noContact.status, 400);
    assert.match(noContact.body.error, /email address or phone/);
    const dupKeys = await h.call("POST", "/api/crm/forms", { name: "X", fields: [{ key: "a", map: "name" }, { key: "a", map: "email" }] }, me.cookie);
    assert.equal(dupKeys.status, 400);
    const ok = await h.call("POST", "/api/crm/forms", FORM, me.cookie);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.tags, ["demo-request", "website"]);
    formId = ok.body.id;
  });

  it("serves the public form without exposing workspace data", async () => {
    const r = await h.call("GET", `/api/public/forms/${formId}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.name, "Book a demo");
    assert.ok(!("workspace" in r.body) && !("tags" in r.body) && !("map" in r.body.fields[0]));
  });

  it("a submission creates a tagged contact with source, company and custom field, and fires events", async () => {
    const r = await h.call("POST", `/api/public/forms/${formId}`, { answers: { name: "Dana Ruiz", email: "Dana@Northwind.example", company: "Northwind Inc", team: "11-50" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const c = h.crm.list("contacts", me.cid)[0];
    assert.equal(c.email, "dana@northwind.example");
    assert.deepEqual(c.tags, ["demo-request", "website"]);
    assert.equal(c.source, `form:${formId}`);
    assert.equal(c.fields?.team_size, "11-50");
    assert.equal(h.crm.company(me.cid, c.companyId!).name, "Northwind Inc");
    assert.deepEqual(h.events.map((e) => e.event.type), ["contact.created", "tag.added", "tag.added", "form.submitted"]);
    assert.equal(h.events[0].ws, me.cid);
  });

  it("a second submission updates the same contact instead of duplicating", async () => {
    await h.call("POST", `/api/public/forms/${formId}`, { answers: { name: "Dana R.", email: "dana@northwind.example", company: "Northwind", team: "51+" } });
    assert.equal(h.crm.list("contacts", me.cid).length, 1);
    assert.equal(h.crm.list("contacts", me.cid)[0].fields?.team_size, "51+");
    assert.equal(h.crm.list("companies", me.cid).length, 1, "matched the existing company");
    assert.equal(h.crm.list("submissions", me.cid).length, 2);
  });

  it("validates answers, drops bot submissions and requires the page's header", async () => {
    const bad = await h.call("POST", `/api/public/forms/${formId}`, { answers: { name: "X", email: "not-an-email", team: "huge" } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /email address.*valid option/);
    const bot = await h.call("POST", `/api/public/forms/${formId}`, { answers: { name: "Bot", email: "bot@spam.example" }, website: "http://spam" });
    assert.equal(bot.status, 200);
    assert.ok(!h.crm.list("contacts", me.cid).some((c) => c.name === "Bot"));
    const crossSite = await h.call("POST", `/api/public/forms/${formId}`, { answers: {} }, undefined, {});
    assert.equal(crossSite.status, 403);
  });

  it("honors opt-outs and rate limits", async () => {
    const c = h.crm.list("contacts", me.cid)[0];
    await h.call("POST", `/api/contacts/${c.id}/opt-out`, {}, me.cookie);
    const r = await h.call("POST", `/api/public/forms/${formId}`, { answers: { name: "Dana", email: "dana@northwind.example" } });
    assert.equal(r.status, 200);
    assert.equal(h.crm.contact(me.cid, c.id).name, "Opted out", "not re-added");
    let limited = 0;
    for (let i = 0; i < 12; i++) {
      const x = await h.call("POST", `/api/public/forms/${formId}`, { answers: { name: `P${i}`, email: `p${i}@x.example` } });
      if (x.status === 429) limited++;
    }
    assert.ok(limited > 0);
  });

  it("closed forms stop accepting responses", async () => {
    await h.call("PATCH", `/api/crm/forms/${formId}`, { active: false }, me.cookie);
    assert.equal((await h.call("GET", `/api/public/forms/${formId}`)).status, 404);
  });

  it("scores leads with reasons and filters with smart lists", async () => {
    const hot = await h.call("POST", "/api/contacts", { name: "Lin Chen", email: "lin@agency.example", influence: "decision-maker" }, me.cookie);
    await h.call("POST", "/api/contacts", { name: "Quiet Person", email: "quiet@x.example" }, me.cookie);
    await h.call("POST", "/api/activities", { kind: "meeting", summary: "Intro", contactIds: [hot.body.id] }, me.cookie);
    await h.call("POST", "/api/activities", { kind: "email", summary: "Asked for pricing", inbound: true, contactIds: [hot.body.id] }, me.cookie);
    const score = await h.call("GET", `/api/crm/contacts/${hot.body.id}/score`, undefined, me.cookie);
    assert.ok(score.body.score >= 40, JSON.stringify(score.body));
    assert.ok(score.body.factors.some((f: any) => f.label === "Decision-maker"));

    const tag = await h.call("POST", `/api/crm/contacts/${hot.body.id}/tags`, { add: ["VIP", "bad tag!!"] }, me.cookie);
    assert.deepEqual(tag.body.tags, ["vip"]);
    assert.equal(h.events.at(-1)!.event.type, "tag.added");

    const list = await h.call("POST", "/api/crm/lists", { name: "Hot VIPs", filter: { tags: ["vip"], minScore: 30 } }, me.cookie);
    assert.equal(list.status, 200);
    const members = await h.call("GET", `/api/crm/contacts?list=${list.body.id}`, undefined, me.cookie);
    assert.deepEqual(members.body.contacts.map((c: any) => c.name), ["Lin Chen"]);
    const lists = await h.call("GET", "/api/crm/lists", undefined, me.cookie);
    assert.equal(lists.body[0].count, 1);
    const all = await h.call("GET", "/api/crm/contacts?sort=score", undefined, me.cookie);
    assert.equal(all.body.contacts[0].name, "Lin Chen", "highest score first");
    assert.ok(all.body.tags.some((t: any) => t.tag === "vip"));
  });

  it("stores custom fields without putting their values on the ledger", async () => {
    const c = h.crm.list("contacts", me.cid).find((x) => x.name === "Lin Chen")!;
    await h.call("POST", `/api/crm/contacts/${c.id}/fields`, { set: { "Annual Budget": "250k" } }, me.cookie);
    assert.equal(h.crm.contact(me.cid, c.id).fields?.annual_budget, "250k");
    assert.ok(!JSON.stringify((await h.ledger.entries()).map((e) => e.payload)).includes("250k"));
    assert.equal((await h.ledger.verify()).ok, true);
  });

  it("keeps workspaces apart", async () => {
    const other = await h.signUp("sam");
    assert.equal((await h.call("GET", `/api/crm/forms/${formId}/submissions`, undefined, other.cookie)).status, 404);
    assert.equal((await h.call("GET", "/api/crm/contacts", undefined, other.cookie)).body.total, 0);
  });

  it("lets the public form page be embedded, and nothing else", async () => {
    const page = await fetch(h.base + "/form.html");
    assert.equal(page.headers.get("x-frame-options"), null);
    assert.match(page.headers.get("content-security-policy")!, /frame-ancestors \*/);
    const app = await fetch(h.base + "/");
    assert.equal(app.headers.get("x-frame-options"), "DENY");
  });
});
