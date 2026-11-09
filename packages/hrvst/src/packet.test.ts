import { test } from "node:test";
import assert from "node:assert/strict";
import { createPacket, privacyFilter } from "./packet.ts";

test("packet is filtered", () => {
  const p = createPacket("cid:user", "image/jpeg", "abc");
  assert.equal(p.filtered, true);
});

test("privacy filter redacts email", () => {
  assert.equal(privacyFilter("contact me at a@b.com"), "contact me at [email]");
});

test("privacy filter redacts spaced phones", () => {
  assert.equal(privacyFilter("call (555) 123-4567 or 555 123 4567"), "call [phone] or [phone]");
});
