import { test } from "node:test";
import assert from "node:assert/strict";
import { createIdentity, verifySignature } from "./identity.ts";
import {
  BROADCAST,
  HEADER_BYTES,
  MAX_PAYLOAD,
  PacketError,
  PacketType,
  buildPacket,
  decodePacket,
  encodePacket,
  forwarded,
  isBroadcast,
  verifyPacket,
} from "./packet.ts";

const alice = createIdentity();
const bob = createIdentity();
const text = (s: string) => new TextEncoder().encode(s);

test("identity: 32-byte address, signatures verify only for the signer", () => {
  assert.equal(alice.publicKey.length, 32);
  assert.equal(alice.id.length, 64);
  const sig = alice.sign(text("hi"));
  assert.ok(verifySignature(alice.publicKey, text("hi"), sig));
  assert.ok(!verifySignature(bob.publicKey, text("hi"), sig));
  assert.ok(!verifySignature(alice.publicKey, text("ho"), sig));
});

test("packet round-trips through the wire format and verifies", () => {
  const p = buildPacket(alice, bob.publicKey, text("hello mesh"), { ttl: 9, timestamp: 1_800_000_000_123 });
  const bytes = encodePacket(p);
  assert.equal(bytes.length, HEADER_BYTES + 10 + 64);
  const d = decodePacket(bytes);
  assert.deepEqual(d.src, alice.publicKey);
  assert.deepEqual(d.dst, bob.publicKey);
  assert.equal(d.ttl, 9);
  assert.equal(d.timestamp, 1_800_000_000_123);
  assert.equal(new TextDecoder().decode(d.payload), "hello mesh");
  assert.ok(verifyPacket(d));
});

test("relays may change ttl and hops without breaking the signature", () => {
  const p = buildPacket(alice, bob.publicKey, text("x"));
  const relayed = decodePacket(encodePacket(forwarded(forwarded(p))));
  assert.equal(relayed.ttl, p.ttl - 2);
  assert.equal(relayed.hops, 2);
  assert.ok(verifyPacket(relayed));
});

test("tampering with payload, dst or src breaks the signature", () => {
  const bytes = encodePacket(buildPacket(alice, bob.publicKey, text("pay 10")));
  for (const offset of [HEADER_BYTES + 4, 60, 30]) {
    const t = bytes.slice();
    t[offset]! ^= 0x01;
    assert.ok(!verifyPacket(decodePacket(t)), `offset ${offset}`);
  }
});

test("malformed input is rejected", () => {
  const good = encodePacket(buildPacket(alice, BROADCAST, text("b")));
  assert.throws(() => decodePacket(good.slice(0, 50)), PacketError);
  const badMagic = good.slice();
  badMagic[0] = 0;
  assert.throws(() => decodePacket(badMagic), PacketError);
  const badVersion = good.slice();
  badVersion[2] = 9;
  assert.throws(() => decodePacket(badVersion), PacketError);
  assert.throws(() => decodePacket(new Uint8Array([...good, 0])), PacketError);
  assert.throws(() => buildPacket(alice, BROADCAST, new Uint8Array(MAX_PAYLOAD + 1)), PacketError);
  assert.throws(() => buildPacket(alice, BROADCAST, text("x"), { ttl: 33 }), PacketError);
});

test("broadcast and receipt types", () => {
  const b = buildPacket(alice, BROADCAST, text("all"));
  assert.ok(isBroadcast(b.dst));
  const r = buildPacket(bob, alice.publicKey, b.msgId, { type: PacketType.Receipt });
  assert.equal(decodePacket(encodePacket(r)).type, PacketType.Receipt);
});
