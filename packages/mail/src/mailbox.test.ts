import assert from "node:assert/strict";
import { test } from "node:test";
import { isE2E, listThreads, unreadInBox } from "./logic.ts";
import { Mailbox } from "./mailbox.ts";

test("seed inbox has four unread threads and keeps VYRAL starred", () => {
  const mail = new Mailbox();
  assert.equal(unreadInBox(mail.messages, "inbox"), 4);
  const rows = listThreads(mail.messages, "inbox", "", false);
  assert.equal(rows[0]?.subject, "VYRAL London — hold the forecast");
  assert.equal(rows[0]?.starred, true);
});

test("mail inside Cumulus is end-to-end and mail to VYRAL is not", () => {
  const mail = new Mailbox();
  const leah = mail.messages.find((message) => message.id === "m-leah-1");
  const priya = mail.messages.find((message) => message.id === "m-priya-1");
  assert.ok(leah && isE2E(leah));
  assert.ok(priya && !isE2E(priya));
});

test("sending drops the draft and files the note under sent", () => {
  const mail = new Mailbox();
  const sent = mail.send({
    to: "leah@cumuluscloud.app",
    subject: "Notes received",
    body: "Got the Drive note.",
    draftId: "m-draft-1",
    now: "2026-11-05T13:00:00.000Z",
  });
  assert.equal(sent.ok, true);
  assert.equal(mail.messages.some((message) => message.id === "m-draft-1"), false);
  assert.equal(mail.messages.find((message) => message.folder === "sent" && message.subject === "Notes received")?.labels[0], "Personal");
  assert.equal(mail.messages.find((message) => message.subject === "Notes received")?.delivery?.[0]?.status, "inside");
});

test("an external Cc is not labeled Personal", () => {
  const mail = new Mailbox();
  const sent = mail.send({
    to: "leah@cumuluscloud.app",
    cc: "priya.shah@vyral.example",
    subject: "Shared note",
    body: "Copying Priya.",
  });
  assert.equal(sent.ok, true);
  const message = mail.messages.find((item) => item.subject === "Shared note");
  assert.equal(message?.labels[0], "External");
  assert.deepEqual(message?.delivery?.map((hop) => hop.status), ["inside", "outbound"]);
});

test("a bad address is refused", () => {
  const mail = new Mailbox();
  const sent = mail.send({ to: "not-an-email", subject: "Hi", body: "Hi" });
  assert.equal(sent.ok, false);
});
