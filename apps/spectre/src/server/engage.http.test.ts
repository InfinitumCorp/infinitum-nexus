import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { harness } from "./test-harness.ts";
import type { OutgoingMessage, MessageProvider } from "../core/messaging.ts";

const MIN = 60_000;

describe("+SPCTR automations", () => {
  let h: Awaited<ReturnType<typeof harness>>;
  let me: { cookie: string; cid: string };
  const sentEmails: OutgoingMessage[] = [];
  const email: MessageProvider = { name: "test-mail", channel: "email", send: async (m) => { sentEmails.push(m); return { providerId: `e${sentEmails.length}` }; } };
  let formId: string;
  let wfId: string;

  before(async () => {
    h = await harness({ providers: { email }, cronSecret: "s3cret-for-tests" });
    me = await h.signUp("alex");
    formId = (await h.call("POST", "/api/crm/forms", {
      name: "Demo", fields: [{ key: "name", map: "name", required: true }, { key: "email", type: "email", map: "email", required: true }],
    }, me.cookie)).body.id;
  });
  after(() => h.close());

  it("validates automations in the builder", async () => {
    const noSteps = await h.call("POST", "/api/crm/workflows", { name: "X", trigger: { type: "contact.created" }, steps: [] }, me.cookie);
    assert.equal(noSteps.status, 400);
    const badWait = await h.call("POST", "/api/crm/workflows", { name: "X", trigger: { type: "contact.created" }, steps: [{ type: "wait", minutes: 0 }] }, me.cookie);
    assert.match(badWait.body.error, /Step 1: wait/);
    const loop = await h.call("POST", "/api/crm/workflows", { name: "X", trigger: { type: "deal.stage_changed", toStage: "won" }, steps: [{ type: "move_deal", stage: "won" }] }, me.cookie);
    assert.match(loop.body.error, /stage that starts/);
    const wrongForm = await h.call("POST", "/api/crm/workflows", { name: "X", trigger: { type: "form.submitted", formId: "fm_nope" }, steps: [{ type: "note", text: "x" }] }, me.cookie);
    assert.equal(wrongForm.status, 400);
  });

  it("runs steps right away, then pauses at a wait", async () => {
    const r = await h.call("POST", "/api/crm/workflows", {
      name: "Demo follow-up",
      trigger: { type: "form.submitted", formId },
      steps: [
        { type: "add_tag", tag: "Demo Lead" },
        { type: "send_email", subject: "Thanks, {{first_name}}", body: "Hi {{first_name}}, here's the deck." },
        { type: "wait", minutes: 60 * 24 },
        { type: "create_task", summary: "Call {{name}}", dueInDays: 0 },
      ],
    }, me.cookie);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    wfId = r.body.id;

    await h.call("POST", `/api/public/forms/${formId}`, { answers: { name: "Dana Ruiz", email: "dana@northwind.example" } });
    const c = h.crm.list("contacts", me.cid)[0];
    assert.deepEqual(c.tags, ["demo-lead"]);
    assert.equal(sentEmails.length, 1);
    assert.equal(sentEmails[0].subject, "Thanks, Dana");
    assert.equal(sentEmails[0].to, "dana@northwind.example");
    assert.ok(!h.crm.list("activities", me.cid).some((a) => a.kind === "task"), "task waits a day");
    const list = await h.call("GET", "/api/crm/workflows", undefined, me.cookie);
    assert.equal(list.body[0].waiting, 1);
    assert.deepEqual(list.body[0].stats, { started: 1, completed: 0, failed: 0 });
  });

  it("the scheduler needs its secret, then resumes jobs whose wait is over", async () => {
    assert.equal((await h.call("POST", "/api/cron/automations", {}, undefined, {})).status, 401);
    assert.equal((await h.call("POST", "/api/cron/automations", {}, undefined, { authorization: "Bearer wrong" })).status, 401);
    const early = await h.call("POST", "/api/cron/automations", {}, undefined, { authorization: "Bearer s3cret-for-tests" });
    assert.equal(early.body.resumed, 0);
    h.advance(24 * 60 * MIN + MIN);
    const due = await h.call("POST", "/api/cron/automations", {}, undefined, { authorization: "Bearer s3cret-for-tests" });
    assert.equal(due.body.resumed, 1);
    const task = h.crm.list("activities", me.cid).find((a) => a.kind === "task")!;
    assert.equal(task.summary, "Call Dana Ruiz");
    assert.equal(task.actorCid, `automation:${wfId}`);
    const jobs = await h.call("GET", `/api/crm/workflows/${wfId}/jobs`, undefined, me.cookie);
    assert.equal(jobs.body[0].status, "done");
    assert.equal(jobs.body[0].contactName, "Dana Ruiz");
    assert.deepEqual(jobs.body[0].log.map((l: any) => l.step), ["add_tag", "send_email", "wait:2", "create_task"]);
  });

  it("chains automations through tags, but a loop stops", async () => {
    // A tags B, B tags A: without the guard this would never end.
    await h.call("POST", "/api/crm/workflows", { name: "A", trigger: { type: "tag.added", tag: "ping" }, steps: [{ type: "remove_tag", tag: "pong" }, { type: "add_tag", tag: "pong" }] }, me.cookie);
    await h.call("POST", "/api/crm/workflows", { name: "B", trigger: { type: "tag.added", tag: "pong" }, steps: [{ type: "remove_tag", tag: "ping" }, { type: "add_tag", tag: "ping" }] }, me.cookie);
    const c = (await h.call("POST", "/api/contacts", { name: "Loop Test", email: "loop@x.example" }, me.cookie)).body;
    const r = await h.call("POST", `/api/crm/contacts/${c.id}/tags`, { add: ["ping"] }, me.cookie);
    assert.equal(r.status, 200);
    const jobs = h.crm.list("jobs", me.cid).filter((j) => j.contactId === c.id);
    assert.ok(jobs.length >= 2 && jobs.length <= 4, `bounded: ${jobs.length}`);
    assert.ok(jobs.every((j) => j.status === "done"));
  });

  it("starts on deal stage changes and works on the deal's people", async () => {
    await h.call("POST", "/api/crm/workflows", {
      name: "Won handoff", trigger: { type: "deal.stage_changed", toStage: "won" },
      steps: [{ type: "create_task", summary: "Kick-off with {{first_name}}" }, { type: "send_email", subject: "Welcome aboard", body: "Hi {{first_name}}" }],
    }, me.cookie);
    const co = (await h.call("POST", "/api/companies", { name: "Contoso" }, me.cookie)).body;
    const sara = (await h.call("POST", "/api/contacts", { name: "Sara Novak", email: "sara@contoso.example", companyId: co.id }, me.cookie)).body;
    const deal = (await h.call("POST", "/api/deals", { companyId: co.id, name: "Pilot", amount: 5000, closeDate: "2026-12-01", contactIds: [sara.id] }, me.cookie)).body;
    await h.call("POST", `/api/deals/${deal.id}/stage`, { stage: "won" }, me.cookie);
    assert.ok(h.crm.list("activities", me.cid).some((a) => a.summary === "Kick-off with Sara" && a.dealId === deal.id));
    assert.equal(sentEmails.at(-1)!.to, "sara@contoso.example");
  });

  it("never messages people who opted out", async () => {
    const before = sentEmails.length;
    const c = h.crm.list("contacts", me.cid).find((x) => x.email === "dana@northwind.example")!;
    await h.call("POST", `/api/contacts/${c.id}/opt-out`, {}, me.cookie);
    await h.call("POST", `/api/public/forms/${formId}`, { answers: { name: "Dana", email: "dana@northwind.example" } });
    assert.equal(sentEmails.length, before);
    const direct = await h.call("POST", `/api/crm/conversations/${c.id}`, { channel: "email", subject: "Hi", body: "Hello" }, me.cookie);
    assert.equal(direct.status, 409);
  });

  it("turning an automation off cancels its waiting runs", async () => {
    await h.call("POST", `/api/public/forms/${formId}`, { answers: { name: "Ben Ito", email: "ben@fabrikam.example" } });
    const waiting = () => h.crm.list("jobs", me.cid).filter((j) => j.workflowId === wfId && j.status === "waiting").length;
    assert.equal(waiting(), 1);
    await h.call("PATCH", `/api/crm/workflows/${wfId}`, { active: false }, me.cookie);
    assert.equal(waiting(), 0);
    const other = await h.signUp("sam");
    assert.equal((await h.call("GET", `/api/crm/workflows/${wfId}`, undefined, other.cookie)).status, 404);
  });
});

describe("+SPCTR conversations", () => {
  let h: Awaited<ReturnType<typeof harness>>;
  let me: { cookie: string; cid: string };
  const TOKEN = "twilio-test-token";
  const sms: OutgoingMessage[] = [];
  let failNext = false;
  const smsProvider: MessageProvider = {
    name: "test-sms", channel: "sms",
    send: async (m) => { if (failNext) { failNext = false; throw new Error("number unreachable"); } sms.push(m); return { providerId: `s${sms.length}` }; },
  };
  let lin: { id: string };

  before(async () => {
    h = await harness({ providers: { sms: smsProvider }, twilioAuthToken: TOKEN });
    me = await h.signUp("alex");
    lin = (await h.call("POST", "/api/contacts", { name: "Lin Chen", email: "lin@agency.example", phone: "+1 (415) 555-0100" }, me.cookie)).body;
  });
  after(() => h.close());

  it("says which channels are connected", async () => {
    const r = await h.call("GET", "/api/crm/conversations", undefined, me.cookie);
    assert.deepEqual(r.body.providers, { email: false, sms: true });
  });

  it("sends SMS through the provider and saves email as a draft when none is connected", async () => {
    const s = await h.call("POST", `/api/crm/conversations/${lin.id}`, { channel: "sms", body: "Hi {{first_name}}, still on for 3pm?" }, me.cookie);
    assert.equal(s.body.status, "sent");
    assert.deepEqual(sms[0], { channel: "sms", to: "+14155550100", subject: undefined, body: "Hi Lin, still on for 3pm?" });
    const e = await h.call("POST", `/api/crm/conversations/${lin.id}`, { channel: "email", subject: "Agenda", body: "Attached." }, me.cookie);
    assert.equal(e.body.status, "draft");
    failNext = true;
    const f = await h.call("POST", `/api/crm/conversations/${lin.id}`, { channel: "sms", body: "Again" }, me.cookie);
    assert.equal(f.body.status, "failed");
    assert.match(f.body.error, /unreachable/);
    const recorded = JSON.stringify((await h.ledger.entries()).map((e) => e.payload));
    assert.ok(!recorded.includes("3pm"), "message text stays off the ledger");
  });

  const sign = (url: string, params: Record<string, string>) =>
    createHmac("sha1", TOKEN).update(url + Object.keys(params).sort().map((k) => k + params[k]).join("")).digest("base64");
  const inbound = (params: Record<string, string>, signature?: string) =>
    fetch(h.base + "/api/hooks/twilio/sms", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...(signature ? { "x-twilio-signature": signature } : {}) },
      body: new URLSearchParams(params).toString(),
    });

  it("receives replies through the signed webhook and shows them unread", async () => {
    const params = { From: "+14155550100", Body: "Yes, see you then", MessageSid: "SM1" };
    assert.equal((await inbound(params, "forged")).status, 403);
    const ok = await inbound(params, sign("http://localhost/api/hooks/twilio/sms", params));
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get("content-type")!, /xml/);
    const list = await h.call("GET", "/api/crm/conversations", undefined, me.cookie);
    assert.equal(list.body.threads[0].unread, 1);
    assert.match(list.body.threads[0].last.preview, /see you then/);
    await h.call("POST", `/api/crm/conversations/${lin.id}/read`, {}, me.cookie);
    const thread = await h.call("GET", `/api/crm/conversations/${lin.id}`, undefined, me.cookie);
    assert.equal(thread.body.unread, 0);
    assert.deepEqual(thread.body.messages.map((m: any) => m.direction + ":" + m.status), ["out:sent", "out:draft", "out:failed", "in:received"]);
  });

  it("STOP opts the sender out", async () => {
    const params = { From: "+14155550100", Body: "STOP", MessageSid: "SM2" };
    await inbound(params, sign("http://localhost/api/hooks/twilio/sms", params));
    assert.equal(h.crm.contact(me.cid, lin.id).optedOut, true);
    const r = await h.call("POST", `/api/crm/conversations/${lin.id}`, { channel: "sms", body: "Hello?" }, me.cookie);
    assert.equal(r.status, 409);
  });
});
