import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToText, toInbound } from "./inbound.ts";

test("envelope addresses decide sender and recipient; headers are display only", () => {
  const m = toInbound("Bounce@Example.com", "Alex@CumulusCloud.app", {
    from: { name: "Priya", address: "spoofed@cumuluscloud.app" },
    to: [{ name: "Alex", address: "alex@cumuluscloud.app" }],
    subject: "  Hi  ",
    text: "Hello\n",
    attachments: [{ filename: "a.pdf", content: new ArrayBuffer(10) }],
  });
  assert.equal(m.from.email, "bounce@example.com");
  assert.equal(m.from.name, "Priya");
  assert.deepEqual(m.recipients, ["alex@cumuluscloud.app"]);
  assert.equal(m.subject, "Hi");
  assert.equal(m.body, "Hello");
  assert.deepEqual(m.attachments, [{ name: "a.pdf", size: 10 }]);
});

test("HTML-only mail becomes readable text", () => {
  assert.equal(htmlToText("<style>p{}</style><p>Hi &amp; bye</p><p>Line<br>two</p>"), "Hi & bye\nLine\ntwo");
  assert.equal(toInbound("a@b.co", "x@cumuluscloud.app", { html: "<b>Bold</b>" }).body, "Bold");
  assert.equal(toInbound("a@b.co", "x@cumuluscloud.app", {}).subject, "(no subject)");
});
