import { test } from "node:test";
import assert from "node:assert/strict";
import { PostOffice, OUTBOUND_MAX_ATTEMPTS } from "./postoffice.ts";

let now = Date.parse("2026-11-09T10:00:00Z");
const setup = async () => {
  now = Date.parse("2026-11-09T10:00:00Z");
  const po = new PostOffice({ clock: () => new Date(now) });
  await po.provision({ cid: "a", address: "alex@cumuluscloud.app", name: "Alex" });
  await po.provision({ cid: "b", address: "sam@cumuluscloud.app", name: "Sam" });
  return po;
};
const sentCopy = async (po: PostOffice, subject: string) => (await po.view("a")).messages.find((m) => m.folder === "sent" && m.subject === subject)!;
const notices = async (po: PostOffice) => (await po.view("a")).messages.filter((m) => m.system === "postmaster");

test("outside recipients are queued with everything needed to send, Cumulus ones delivered", async () => {
  const po = await setup();
  const r = await po.send("a", { to: "priya@gmail.com, sam@cumuluscloud.app", cc: "Lee <lee@example.org>", subject: "Plans", body: "See you at 3." });
  assert.equal(r.queued, 2);
  const [job] = await po.claimOutbound();
  assert.deepEqual(job, {
    id: job!.id,
    from: { email: "alex@cumuluscloud.app", name: "Alex" },
    to: ["priya@gmail.com"],
    cc: ["lee@example.org"],
    subject: "Plans",
    text: job!.text,
    attachments: [],
  });
  assert.match(job!.text, /^See you at 3./);
  assert.equal((await po.claimOutbound()).length, 0, "a claimed job isn't handed out twice");
});

test("a sent job shows as sent on the sender's copy", async () => {
  const po = await setup();
  await po.send("a", { to: "priya@gmail.com", subject: "Hi", body: "Hello" });
  const [job] = await po.claimOutbound();
  await po.finishOutbound(job!.id, { ok: true, providerId: "cf-1" });
  const hop = (await sentCopy(po, "Hi")).delivery!.find((h) => h.email === "priya@gmail.com")!;
  assert.equal(hop.status, "outbound");
  assert.match(hop.detail, /Sent to the recipient's mail server/);
  assert.equal((await po.outboundQueue()).length, 0);
  assert.equal((await notices(po)).length, 0);
});

test("temporary failures retry with growing gaps, then the sender is told", async () => {
  const po = await setup();
  await po.send("a", { to: "priya@gmail.com", subject: "Retry me", body: "x" });
  for (let attempt = 1; attempt <= OUTBOUND_MAX_ATTEMPTS; attempt++) {
    const [job] = await po.claimOutbound();
    assert.ok(job, `attempt ${attempt} is due`);
    await po.finishOutbound(job.id, { ok: false, error: "Rate limited", permanent: false });
    if (attempt < OUTBOUND_MAX_ATTEMPTS) {
      assert.equal((await po.claimOutbound()).length, 0, "not due again right away");
      now += 60_000 * 2 ** (attempt - 1);
    }
  }
  assert.equal((await sentCopy(po, "Retry me")).delivery![0]!.status, "bounced");
  assert.equal((await notices(po)).length, 1);
  assert.match((await notices(po))[0]!.subject, /Not delivered: Retry me/);
});

test("a permanent failure bounces at once with the reason", async () => {
  const po = await setup();
  await po.send("a", { to: "nobody@gmail.com", subject: "Bad", body: "x" });
  const [job] = await po.claimOutbound();
  await po.finishOutbound(job!.id, { ok: false, error: "The recipient's address doesn't exist.", permanent: true });
  assert.equal((await notices(po)).length, 1);
  assert.match((await notices(po))[0]!.body, /doesn't exist/);
  assert.equal((await po.claimOutbound()).length, 0);
});

test("a job whose run stopped mid-send is never sent twice; the sender is told", async () => {
  const po = await setup();
  await po.send("a", { to: "priya@gmail.com", subject: "Crash", body: "x" });
  assert.equal((await po.claimOutbound()).length, 1);
  now += 5 * 60_000;
  assert.equal((await po.claimOutbound()).length, 0);
  now += 6 * 60_000;
  assert.equal((await po.claimOutbound()).length, 0, "not handed out again");
  assert.match((await notices(po))[0]!.subject, /Delivery not confirmed: Crash/);
  assert.match((await sentCopy(po, "Crash")).delivery![0]!.detail, /couldn't be confirmed/);
  now += 60 * 60_000;
  assert.equal((await po.claimOutbound()).length, 0);
  assert.equal((await notices(po)).length, 1, "told once");
});

test("jobs queued before sending existed are closed with a notice, not sent blind", async () => {
  const po = await setup();
  await po.send("a", { to: "priya@gmail.com", subject: "Old", body: "x" });
  const legacy = [...(po as any).store.outbound.values()][0];
  delete legacy.body; delete legacy.messageId; delete legacy.toList;
  assert.equal((await po.claimOutbound()).length, 0);
  assert.equal((await notices(po)).length, 1);
  assert.equal(legacy.status, "failed");
});

test("stored files ride along; name-only entries and storage are counted", async () => {
  const po = await setup();
  const files = [{ name: "plan.pdf", size: 1000, id: "u/a/1", type: "application/pdf" }, { name: "old.txt", size: 10 }];
  await po.send("a", { to: "priya@gmail.com", subject: "Files", body: "x", attachments: files });
  const [job] = await po.claimOutbound();
  assert.deepEqual(job!.attachments, [{ id: "u/a/1", name: "plan.pdf", type: "application/pdf", size: 1000 }]);
  assert.deepEqual((await sentCopy(po, "Files")).attachments, files);
});
