import { test } from "node:test";
import assert from "node:assert/strict";
import { createMessage, decrypt } from "./message.ts";

test("encrypt and decrypt round-trip", () => {
  const m = createMessage("a", "b", "hello", "key");
  assert.equal(decrypt(m.ciphertext, "key"), "hello");
  assert.notEqual(m.ciphertext, Buffer.from("hello").toString("base64"));
  assert.throws(() => decrypt(m.ciphertext, "other"));
});
