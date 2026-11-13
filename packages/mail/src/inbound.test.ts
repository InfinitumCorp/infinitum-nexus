import { test } from "node:test";
import assert from "node:assert/strict";
import { PostOffice, MailError } from "./postoffice.ts";

const setup = () => {
  const po = new PostOffice({ clock: () => new Date("2026-11-09T10:00:00Z") });
  po.provision({ cid: "a", address: "alex@cumuluscloud.app", name: "Alex" });
  return po;
};
const mail = (over: Partial<Parameters<PostOffice["receive"]>[0]> = {}) => ({
  from: { name: "Priya", email: "Priya@Example.com" },
  recipients: ["alex@cumuluscloud.app"],
  to: [{ name: "Alex", email: "alex@cumuluscloud.app" }],
  cc: [],
  subject: "Hello from outside",
  body: "Hi Alex",
  ...over,
});

test("outside mail lands unread in the recipient's inbox", async () => {
  const po = setup();
  assert.deepEqual(await po.receive(mail()), { delivered: ["alex@cumuluscloud.app"], unknown: [] });
  const m = po.view("a").messages.find((x) => x.subject === "Hello from outside")!;
  assert.equal(m.folder, "inbox");
  assert.equal(m.unread, true);
  assert.equal(m.from.email, "priya@example.com");
  assert.equal(m.body, "Hi Alex");
});

test("unknown Cumulus and non-Cumulus recipients are reported, not delivered", async () => {
  const po = setup();
  const r = await po.receive(mail({ recipients: ["nobody@cumuluscloud.app", "someone@else.com"] }));
  assert.deepEqual(r, { delivered: [], unknown: ["nobody@cumuluscloud.app", "someone@else.com"] });
});

test("mail claiming a Cumulus sender is refused", async () => {
  const po = setup();
  await assert.rejects(po.receive(mail({ from: { name: "Security", email: "security@cumuluscloud.app" } })), (e: unknown) => e instanceof MailError && e.code === "spoofed_sender");
});

test("a reply joins the thread with that sender", async () => {
  const po = setup();
  await po.receive(mail({ subject: "Lunch" }));
  await po.receive(mail({ subject: "Re: Lunch", body: "Tuesday?" }));
  await po.receive(mail({ from: { name: "Other", email: "other@example.com" }, subject: "Re: Lunch" }));
  const msgs = po.view("a").messages.filter((m) => /lunch/i.test(m.subject));
  const first = msgs.find((m) => m.subject === "Lunch")!;
  assert.equal(msgs.find((m) => m.body === "Tuesday?")!.threadId, first.threadId);
  assert.notEqual(msgs.find((m) => m.from.email === "other@example.com")!.threadId, first.threadId);
});
