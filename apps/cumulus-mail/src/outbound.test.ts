import { test } from "node:test";
import assert from "node:assert/strict";
import { PostOffice } from "@infinitum/mail";
import { MemoryFileStore } from "./files.ts";
import { cloudflareSender, deliverOutbound, textToHtml, type EmailBinding } from "./outbound.ts";

const tx = <T>(fn: () => Promise<T>) => fn();
const failing = (code: string): EmailBinding => ({
  send: async () => {
    throw Object.assign(new Error(code), { code });
  },
});

test("sends through the binding with the sender's name and the right recipients", async () => {
  const calls: unknown[] = [];
  const binding: EmailBinding = { send: async (m) => (calls.push(m), { messageId: "cf-123" }) };
  const result = await cloudflareSender(binding)({ id: "out-1", from: { email: "alex@cumuluscloud.app", name: "Alex" }, to: ["priya@gmail.com"], cc: [], subject: "", text: "Hi", attachments: [] });
  assert.deepEqual(result, { ok: true, providerId: "cf-123" });
  assert.deepEqual(calls, [{ to: ["priya@gmail.com"], cc: undefined, from: { email: "alex@cumuluscloud.app", name: "Alex" }, subject: "(no subject)", text: "Hi", html: textToHtml("Hi"), headers: { "X-Cumulus-Job": "out-1" } }]);
});

test("errors that will repeat are permanent; service trouble is retried", async () => {
  const job = { id: "out-1", from: { email: "a@cumuluscloud.app" }, to: ["x@gmail.com"], cc: [], subject: "s", text: "t", attachments: [] };
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
  await po.provision({ cid: "a", address: "alex@cumuluscloud.app", name: "Alex" });
  await po.send("a", { to: "priya@gmail.com", subject: "One", body: "1" });
  await po.send("a", { to: "gone@example.com", subject: "Two", body: "2" });
  const sent: string[] = [];
  const count = await deliverOutbound(tx, po, async (job) => {
    sent.push(job.subject);
    return job.subject === "One" ? { ok: true, providerId: "p" } : { ok: false, error: "The recipient's mail server refused the message.", permanent: true };
  });
  assert.equal(count, 1);
  assert.deepEqual(sent.sort(), ["One", "Two"]);
  assert.equal((await po.outboundQueue()).length, 0);
  const notices = (await po.view("a")).messages.filter((m) => m.system === "postmaster");
  assert.deepEqual(notices.map((m) => m.subject), ["Not delivered: Two"]);
  assert.equal(await deliverOutbound(tx, po, async () => assert.fail("nothing left to send")), 0);
});

test("a sender that throws counts as a temporary failure", async () => {
  const po = new PostOffice({ clock: () => new Date("2026-11-09T10:00:00Z") });
  await po.provision({ cid: "a", address: "alex@cumuluscloud.app", name: "Alex" });
  await po.send("a", { to: "priya@gmail.com", subject: "Boom", body: "x" });
  assert.equal(await deliverOutbound(tx, po, async () => { throw new Error("network down"); }), 0);
  assert.equal((await po.outboundQueue()).length, 1, "back in the queue for a retry");
});

test("HTML version: escaped, paragraphs, line breaks and links", () => {
  const html = textToHtml("Hi <b>Sam</b> & co,\nsee https://cumuluscloud.app/x?a=1&b=2.\n\nThanks");
  assert.ok(html.includes('<p style="margin:0 0 1em">Hi &lt;b&gt;Sam&lt;/b&gt; &amp; co,<br>see <a href="https://cumuluscloud.app/x?a=1&amp;b=2">https://cumuluscloud.app/x?a=1&amp;b=2</a>.</p>'), html);
  assert.ok(html.includes('<p style="margin:0 0 1em">Thanks</p>'), html);
  assert.doesNotMatch(html, /<b>/);
});

test("each result is recorded as soon as it's known", async () => {
  const po = new PostOffice({ clock: () => new Date("2026-11-09T10:00:00Z") });
  await po.provision({ cid: "a", address: "alex@cumuluscloud.app", name: "Alex" });
  await po.send("a", { to: "fast@gmail.com", subject: "Fast", body: "1" });
  await po.send("a", { to: "slow@gmail.com", subject: "Slow", body: "2" });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let recordedBeforeSlow = false;
  const run = deliverOutbound(tx, po, async (job) => {
    if (job.subject === "Slow") {
      await gate;
      return { ok: true };
    }
    return { ok: true };
  });
  await new Promise((r) => setTimeout(r, 10));
  recordedBeforeSlow = (await po.outboundQueue()).length === 0 && (po as any).store.outbound.size === 2 &&
    [...(po as any).store.outbound.values()].some((j: any) => j.subject === "Fast" && j.status === "sent");
  release();
  assert.equal(await run, 2);
  assert.ok(recordedBeforeSlow, "the fast job was recorded while the slow one was still sending");
});

test("stored attachments go out with the message; missing or oversized ones bounce", async () => {
  const store = new MemoryFileStore();
  await store.put("u/a/11111111-1111-1111-1111-111111111111", new TextEncoder().encode("hello"), "text/plain");
  const calls: any[] = [];
  const binding: EmailBinding = { send: async (m) => (calls.push(m), { messageId: "x" }) };
  const base = { id: "out-1", from: { email: "a@cumuluscloud.app" }, to: ["x@gmail.com"], cc: [], subject: "s", text: "t" };
  const ok = await cloudflareSender(binding, store)({ ...base, attachments: [{ id: "u/a/11111111-1111-1111-1111-111111111111", name: "hi.txt", type: "text/plain", size: 5 }] });
  assert.equal(ok.ok, true);
  assert.equal(calls[0].attachments[0].filename, "hi.txt");
  assert.equal(new TextDecoder().decode(calls[0].attachments[0].content), "hello");
  const missing = await cloudflareSender(binding, store)({ ...base, attachments: [{ id: "u/a/22222222-2222-2222-2222-222222222222", name: "gone.pdf", size: 5 }] });
  assert.equal(!missing.ok && missing.permanent, true);
  const huge = await cloudflareSender(binding, store)({ ...base, attachments: [{ id: "u/a/1", name: "big.zip", size: 30 * 1024 * 1024 }] });
  assert.equal(!huge.ok && huge.permanent, true);
});
