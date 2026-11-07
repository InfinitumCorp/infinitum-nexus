import { test } from "node:test";
import assert from "node:assert/strict";
import { encryptAead, decryptAead, open, randomKey, seal } from "./aead.ts";

test("AEAD round-trip", () => {
  const enc = encryptAead("secret", "password");
  assert.equal(decryptAead(enc, "password"), "secret");
  assert.notEqual(enc, Buffer.from("secret").toString("base64"));
  assert.throws(() => decryptAead(enc, "other"));
});

test("raw-key seal binds associated data", () => {
  const key = randomKey();
  const first = seal("hello", key, "session-1");
  const second = seal("hello", key, "session-1");
  assert.notEqual(first, second);
  assert.equal(open(first, key, "session-1"), "hello");
  assert.throws(() => open(first, key, "session-2"));
  assert.throws(() => open(first, randomKey(), "session-1"));
  const flipped = Buffer.from(first, "base64");
  flipped[flipped.length - 1] ^= 0xff;
  assert.throws(() => open(flipped.toString("base64"), key, "session-1"));
  assert.throws(() => seal("hello", Buffer.alloc(16)));
});
