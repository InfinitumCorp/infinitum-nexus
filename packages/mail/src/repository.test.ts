/**
 * The PostOffice reads and writes only through MailRepository: with a repository that copies values
 * in and out (as a database does), every flow still works, so nothing relies on changing a shared
 * object in place.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PostOffice, PostOfficeStore } from "./postoffice.ts";
import { CopyingMailRepository } from "./repository.ts";

function office() {
  let now = Date.parse("2026-11-13T10:00:00Z");
  const store = new PostOfficeStore();
  const repository = new CopyingMailRepository(store);
  const po = new PostOffice({ repository, clock: () => new Date(now) });
  return { po, store, repository, later: (ms: number) => { now += ms; } };
}

test("mail between Cumulus accounts, replies, stars and folders persist through the repository", async () => {
  const { po, store } = office();
  await po.provision({ cid: "a", address: "alex@cumuluscloud.app", name: "Alex" });
  await po.provision({ cid: "b", address: "sam@cumuluscloud.app", name: "Sam" });
  assert.equal(await po.resolve("SAM@cumuluscloud.app"), "b");

  const r = await po.send("a", { to: "sam@cumuluscloud.app", subject: "Plans", body: "3pm?" });
  assert.equal(r.delivered, 1);
  const inbox = (await po.view("b")).messages.filter((m) => m.folder === "inbox");
  assert.equal(inbox.length, 1);
  assert.equal(await po.unreadCount("b"), 1);

  await po.markThreadRead("b", inbox[0].threadId);
  await po.toggleStar("b", inbox[0].id);
  assert.equal(await po.unreadCount("b"), 0);
  assert.equal((await po.message("b", inbox[0].id))?.starred, true);

  // Archive with undo.
  const { before } = await po.actOnThreads("b", [inbox[0].threadId], "archive");
  assert.equal((await po.message("b", inbox[0].id))?.folder, "archive");
  assert.equal(await po.restore("b", before), 1);
  assert.equal((await po.message("b", inbox[0].id))?.folder, "inbox");

  // The stored copy is what the repository was given, not an object the PostOffice still holds.
  const stored = store.mailboxes.get("b")!;
  const returned = (await po.view("b")).messages[0];
  returned.subject = "changed outside";
  assert.equal(store.mailboxes.get("b")!.messages[0].subject, "Plans");
  assert.notEqual(stored, (await po.view("b")) as unknown);
});

test("a missing address bounces with a notice, delivered in the same call", async () => {
  const { po } = office();
  await po.provision({ cid: "a", address: "alex@cumuluscloud.app" });
  const r = await po.send("a", { to: "nobody@cumuluscloud.app", subject: "Hi", body: "x" });
  assert.deepEqual(r.bounced, ["nobody@cumuluscloud.app"]);
  const box = (await po.view("a")).messages;
  assert.equal(box.filter((m) => m.system === "postmaster").length, 1);
  assert.equal(box.find((m) => m.folder === "sent")?.delivery?.[0]?.status, "bounced");
});

test("aliases are unique across Cumulus and resolve to their owner", async () => {
  const { po } = office();
  await po.provision({ cid: "a", address: "alex@cumuluscloud.app" });
  await po.provision({ cid: "b", address: "sam@cumuluscloud.app" });
  assert.equal(await po.addAlias("a", "alex.work@cumuluscloud.app"), true);
  assert.equal(await po.addAlias("b", "alex.work@cumuluscloud.app"), false);
  assert.equal(await po.addAlias("b", "sam@cumuluscloud.app"), false);
  assert.equal(await po.resolve("alex.work@cumuluscloud.app"), "a");
  assert.deepEqual((await po.view("a")).aliases.includes("alex.work@cumuluscloud.app"), true);
  await assert.rejects(po.provision({ cid: "c", address: "alex.work@cumuluscloud.app" }), /another Cumulus:\/\/ID/);
});

test("outside mail: queued, claimed once, retried, then sent; progress shows on the sender's copy", async () => {
  const { po, later } = office();
  await po.provision({ cid: "a", address: "alex@cumuluscloud.app" });
  await po.send("a", { to: "priya@example.com", subject: "Out", body: "hello" });
  assert.equal((await po.outboundQueue()).length, 1);

  const [job] = await po.claimOutbound();
  assert.ok(job);
  assert.deepEqual(await po.claimOutbound(), [], "a claimed job isn't handed out twice");

  await po.finishOutbound(job.id, { ok: false, error: "421 try later", permanent: false });
  assert.equal((await po.outboundQueue()).length, 1);
  assert.deepEqual(await po.claimOutbound(), [], "not before the retry time");
  later(61_000);
  const [again] = await po.claimOutbound();
  assert.equal(again.id, job.id);
  await po.finishOutbound(job.id, { ok: true, providerId: "p1" });
  assert.equal((await po.outboundQueue()).length, 0);
  const sent = (await po.view("a")).messages.find((m) => m.folder === "sent")!;
  assert.equal(sent.delivery?.[0]?.detail, "Sent to the recipient's mail server.");
});

test("a job left in sending is closed as unconfirmed with a notice, never re-sent", async () => {
  const { po, later } = office();
  await po.provision({ cid: "a", address: "alex@cumuluscloud.app" });
  await po.send("a", { to: "priya@example.com", subject: "Out", body: "hello" });
  await po.claimOutbound();
  later(11 * 60_000);
  assert.deepEqual(await po.claimOutbound(), []);
  const notices = (await po.view("a")).messages.filter((m) => m.system === "postmaster");
  assert.equal(notices.length, 1);
  assert.match(notices[0].subject, /Delivery not confirmed/);
});

test("scheduled send, Clean rules and muting persist", async () => {
  const { po, later } = office();
  await po.provision({ cid: "a", address: "alex@cumuluscloud.app" });
  await po.provision({ cid: "b", address: "sam@cumuluscloud.app" });
  const { id } = await po.schedule("a", { to: "sam@cumuluscloud.app", subject: "Later", body: "x" }, new Date(Date.parse("2026-11-13T12:00:00Z")).toISOString());
  assert.ok((await po.message("a", id))?.sendAt);
  assert.equal(await po.sendAllDue(), 0);
  later(3 * 3_600_000);
  assert.equal(await po.sendAllDue(), 1);
  assert.equal((await po.view("b")).messages.filter((m) => m.subject === "Later").length, 1);

  await po.setCleanRules("a", { auto: false });
  assert.equal((await po.cleanState("a")).rules.auto, false);
  await po.send("b", { to: "alex@cumuluscloud.app", subject: "Deal", body: "buy" });
  // Unread mail from a person is protected from cleaning; read it first.
  await po.markThreadRead("a", (await po.view("a")).messages.find((m) => m.subject === "Deal")!.threadId);
  const log = await po.muteSender("a", "sam@cumuluscloud.app");
  assert.equal(log.length, 1);
  assert.deepEqual((await po.cleanState("a")).rules.muted, ["sam@cumuluscloud.app"]);
  assert.equal((await po.view("a")).messages.find((m) => m.subject === "Deal")?.folder, "archive");
  assert.equal(await po.undoClean("a", log[0].id), 1);
  assert.equal((await po.view("a")).messages.find((m) => m.subject === "Deal")?.folder, "inbox");
  await po.unmuteSender("a", "sam@cumuluscloud.app");
  assert.deepEqual((await po.cleanState("a")).rules.muted, []);
});

test("reading never writes", async () => {
  const { po, repository } = office();
  await po.provision({ cid: "a", address: "alex@cumuluscloud.app" });
  let puts = 0;
  const put = repository.putMailbox.bind(repository);
  repository.putMailbox = async (box) => { puts++; return put(box); };
  await po.view("a");
  await po.cleanState("a");
  await po.previewClean("a");
  await po.message("a", "x");
  await po.unreadCount("a");
  await po.addressOf("a");
  assert.equal(puts, 0);
});
