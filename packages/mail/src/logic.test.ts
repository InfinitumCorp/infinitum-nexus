import assert from "node:assert/strict";
import { test } from "node:test";
import { MAIL_DOMAIN } from "@infinitum/cid";
import { applyRules, inBox, isCumulus, isSnoozed, listThreads, planDelivery, tomorrowMorning, withSignature } from "./logic.ts";
import { ME, SEED_MESSAGES, type MailMessage } from "./model.ts";

test("only the configured Cumulus domain stays inside", async () => {
  assert.equal(isCumulus(`alex@${MAIL_DOMAIN}`), true);
  assert.equal(isCumulus("alex@cumulusmail.cloud"), false);
  assert.equal(isCumulus("alex@*.cumuluscloud.app"), false);
});

test("Cumulus recipients stay inside and everyone else is outbound", async () => {
  const hops = planDelivery([
    { name: "Leah", email: "leah@cumuluscloud.app" },
    { name: "Priya", email: "priya.shah@vyral.example" },
    { name: "Leah again", email: "Leah@cumuluscloud.app" },
  ]);
  assert.equal(hops.length, 2);
  assert.equal(hops[0]?.status, "inside");
  assert.equal(hops[1]?.status, "outbound");
});

test("from: finds a sender and has:file finds an attachment", async () => {
  const withFile: MailMessage = {
    ...SEED_MESSAGES[0]!,
    id: "file-1",
    threadId: "file-1",
    attachments: [{ name: "forecast.pdf", size: 1200 }],
  };
  const messages = [withFile, ...SEED_MESSAGES];
  assert.equal(listThreads(messages, "inbox", "from:leah", false).length > 0, true);
  assert.equal(listThreads(messages, "inbox", "from:nobody-zzz", false).length, 0);
  assert.equal(listThreads(messages, "inbox", "has:file", false)[0]?.id, "file-1");
  assert.equal(ME.email.endsWith("@cumuluscloud.app"), true);
});

test("a search term can match a different message in the same thread", async () => {
  const first: MailMessage = {
    ...SEED_MESSAGES[0]!,
    id: "t-1",
    threadId: "th-split",
    from: { name: "Leah Okonkwo", email: "leah@cumuluscloud.app" },
    subject: "Hello",
    body: "See you Thursday.",
    attachments: undefined,
  };
  const reply: MailMessage = {
    ...SEED_MESSAGES[0]!,
    id: "t-2",
    threadId: "th-split",
    from: { name: "Alex Reid", email: ME.email },
    subject: "Re: Hello",
    body: "The budget appendix is attached in Drive.",
    at: "2026-11-05T13:00:00.000Z",
  };
  const rows = listThreads([first, reply, ...SEED_MESSAGES], "inbox", "from:leah budget", false);
  assert.equal(rows.some((row) => row.threadId === "th-split"), true);
});

test("a snoozed note leaves the inbox and an outside send sits in the outbox", async () => {
  const message = { ...SEED_MESSAGES[0]!, snoozeUntil: "2099-01-01T00:00:00.000Z" };
  assert.equal(isSnoozed(message, Date.parse("2026-11-05T00:00:00.000Z")), true);
  assert.equal(inBox(message, "inbox", Date.parse("2026-11-05T00:00:00.000Z")), false);
  assert.equal(inBox(message, "snoozed", Date.parse("2026-11-05T00:00:00.000Z")), true);
  assert.equal(inBox(message, "inbox", Date.parse("2099-01-02T00:00:00.000Z")), true);
  const sent = {
    ...SEED_MESSAGES[0]!,
    id: "out-1",
    folder: "sent" as const,
    delivery: [{ email: "a@vyral.example", status: "outbound" as const, detail: "Accepted." }],
  };
  assert.equal(inBox(sent, "outbox"), true);
  assert.equal(tomorrowMorning(new Date("2026-11-05T22:00:00.000Z")), "2026-11-06T08:00:00.000Z");
});

test("rules archive a match and the signature stays above a quote", async () => {
  const message = applyRules(SEED_MESSAGES.find((item) => item.from.email.includes("vyral"))!, [
    { id: "r1", from: "vyral", action: "archive" },
  ]);
  assert.equal(message.folder, "archive");
  const signed = withSignature("Hello\n\n—\nOn Monday, Leah wrote:\n> Hi", "Alex Reid");
  assert.equal(signed.startsWith("Hello\n\nAlex Reid\n\n—\n"), true);
});
