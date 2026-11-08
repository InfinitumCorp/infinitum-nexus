import { test } from "node:test";
import assert from "node:assert/strict";
import { PostOffice } from "@infinitum/mail";
import { cloudflareSender, deliverOutbound, type EmailBinding } from "./outbound.ts";

const tx = <T>(fn: () => Promise<T>) => fn();
const failing = (code: string): EmailBinding => ({
  send: async () => {
    throw Object.assign(new Error(code), { code });
  },
});

test("sends through the binding with the sender's name and the right recipients", async () => {
  const calls: unknown[] = [];
  const binding: EmailBinding = { send: async (m) => (calls.push(m), { messageId: "cf-123" }) };
  const result = await cloudflareSender(binding)({ id: "out-1", from: { email: "alex@cumuluscloud.app", name: "Alex" }, to: ["priya@gmail.com"], cc: [], subject: "", text: "Hi" });
  assert.deepEqual(result, { ok: true, providerId: "cf-123" });
  assert.deepEqual(calls, [{ to: ["priya@gmail.com"], cc: undefined, from: { email: "alex@cumuluscloud.app", name: "Alex" }, subject: "(no subject)", text: "Hi" }]);
});

test("errors that will repeat are permanent; service trouble is retried", async () => {
  const job = { id: "out-1", from: { email: "a@cumuluscloud.app" }, to: ["x@gmail.com"], cc: [], subject: "s", text: "t" };
  const suppressed = await cloudflareSender(failing("E_RECIPIENT_SUPPRESSED"))(job);
  assert.equal(suppressed.ok, false);
  assert.equal(!suppressed.ok && suppressed.permanent, true);
  for (const code of ["E_RATE_LIMIT_EXCEEDED", "E_SENDER_NOT_VERIFIED", "E_INTERNAL_SERVER_ERROR", ""]) {
    const r = await cloudflareSender(failing(code))(job);
    assert.equal(!r.ok && r.permanent, false, code);
  }
});

test("deliverOutbound claims, sends and records outcomes", async () => {
  const po = new PostOffice({ clock: () => new Date("2026-11-09T10:00:00Z") });
  po.provision({ cid: "a", address: "alex@cumuluscloud.app", name: "Alex" });
  await po.send("a", { to: "priya@gmail.com", subject: "One", body: "1" });
  await po.send("a", { to: "gone@example.com", subject: "Two", body: "2" });
  const sent: string[] = [];
  const count = await deliverOutbound(tx, po, async (job) => {
    sent.push(job.subject);
    return job.subject === "One" ? { ok: true, providerId: "p" } : { ok: false, error: "The recipient's mail server refused the message.", permanent: true };
  });
  assert.equal(count, 1);
  assert.deepEqual(sent.sort(), ["One", "Two"]);
  assert.equal(po.outboundQueue().length, 0);
  const notices = po.view("a").messages.filter((m) => m.system === "postmaster");
  assert.deepEqual(notices.map((m) => m.subject), ["Not delivered: Two"]);
  assert.equal(await deliverOutbound(tx, po, async () => assert.fail("nothing left to send")), 0);
});

test("a sender that throws counts as a temporary failure", async () => {
  const po = new PostOffice({ clock: () => new Date("2026-11-09T10:00:00Z") });
  po.provision({ cid: "a", address: "alex@cumuluscloud.app", name: "Alex" });
  await po.send("a", { to: "priya@gmail.com", subject: "Boom", body: "x" });
  assert.equal(await deliverOutbound(tx, po, async () => { throw new Error("network down"); }), 0);
  assert.equal(po.outboundQueue().length, 1, "back in the queue for a retry");
});
