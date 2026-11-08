import { test } from "node:test";
import assert from "node:assert/strict";
import { PostOffice, OUTBOUND_MAX_ATTEMPTS } from "./postoffice.ts";

let now = Date.parse("2026-11-09T10:00:00Z");
const setup = () => {
  now = Date.parse("2026-11-09T10:00:00Z");
  const po = new PostOffice({ clock: () => new Date(now) });
  po.provision({ cid: "a", address: "alex@cumuluscloud.app", name: "Alex" });
  po.provision({ cid: "b", address: "sam@cumuluscloud.app", name: "Sam" });
  return po;
};
const sentCopy = (po: PostOffice, subject: string) => po.view("a").messages.find((m) => m.folder === "sent" && m.subject === subject)!;
const notices = (po: PostOffice) => po.view("a").messages.filter((m) => m.system === "postmaster");

test("outside recipients are queued with everything needed to send, Cumulus ones delivered", async () => {
  const po = setup();
  const r = await po.send("a", { to: "priya@gmail.com, sam@cumuluscloud.app", cc: "Lee <lee@example.org>", subject: "Plans", body: "See you at 3." });
  assert.equal(r.queued, 2);
  const [job] = po.claimOutbound();
  assert.deepEqual(job, {
    id: job!.id,
    from: { email: "alex@cumuluscloud.app", name: "Alex" },
    to: ["priya@gmail.com"],
    cc: ["lee@example.org"],
    subject: "Plans",
    text: job!.text,
  });
  assert.match(job!.text, /^See you at 3./);
  assert.equal(po.claimOutbound().length, 0, "a claimed job isn't handed out twice");
});

test("a sent job shows as sent on the sender's copy", async () => {
  const po = setup();
  await po.send("a", { to: "priya@gmail.com", subject: "Hi", body: "Hello" });
  const [job] = po.claimOutbound();
  po.finishOutbound(job!.id, { ok: true, providerId: "cf-1" });
  const hop = sentCopy(po, "Hi").delivery!.find((h) => h.email === "priya@gmail.com")!;
  assert.equal(hop.status, "outbound");
  assert.match(hop.detail, /Sent to the recipient's mail server/);
  assert.equal(po.outboundQueue().length, 0);
  assert.equal(notices(po).length, 0);
});

test("temporary failures retry with growing gaps, then the sender is told", async () => {
  const po = setup();
  await po.send("a", { to: "priya@gmail.com", subject: "Retry me", body: "x" });
  for (let attempt = 1; attempt <= OUTBOUND_MAX_ATTEMPTS; attempt++) {
    const [job] = po.claimOutbound();
    assert.ok(job, `attempt ${attempt} is due`);
    po.finishOutbound(job.id, { ok: false, error: "Rate limited", permanent: false });
    if (attempt < OUTBOUND_MAX_ATTEMPTS) {
      assert.equal(po.claimOutbound().length, 0, "not due again right away");
      now += 60_000 * 2 ** (attempt - 1);
    }
  }
  assert.equal(sentCopy(po, "Retry me").delivery![0]!.status, "bounced");
  assert.equal(notices(po).length, 1);
  assert.match(notices(po)[0]!.subject, /Not delivered: Retry me/);
});

test("a permanent failure bounces at once with the reason", async () => {
  const po = setup();
  await po.send("a", { to: "nobody@gmail.com", subject: "Bad", body: "x" });
  const [job] = po.claimOutbound();
  po.finishOutbound(job!.id, { ok: false, error: "The recipient's address doesn't exist.", permanent: true });
  assert.equal(notices(po).length, 1);
  assert.match(notices(po)[0]!.body, /doesn't exist/);
  assert.equal(po.claimOutbound().length, 0);
});

test("a job whose sender crashed goes back in the queue after 10 minutes", async () => {
  const po = setup();
  await po.send("a", { to: "priya@gmail.com", subject: "Crash", body: "x" });
  assert.equal(po.claimOutbound().length, 1);
  now += 5 * 60_000;
  assert.equal(po.claimOutbound().length, 0);
  now += 6 * 60_000;
  assert.equal(po.claimOutbound().length, 1);
});

test("jobs queued before sending existed are closed with a notice, not sent blind", async () => {
  const po = setup();
  await po.send("a", { to: "priya@gmail.com", subject: "Old", body: "x" });
  const legacy = [...(po as any).store.outbound.values()][0];
  delete legacy.body; delete legacy.messageId; delete legacy.toList;
  assert.equal(po.claimOutbound().length, 0);
  assert.equal(notices(po).length, 1);
  assert.equal(legacy.status, "failed");
});
