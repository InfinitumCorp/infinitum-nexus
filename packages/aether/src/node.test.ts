import { test } from "node:test";
import assert from "node:assert/strict";
import { createIdentity } from "./identity.ts";
import { MeshNode, type Delivered } from "./node.ts";
import { buildPacket, encodePacket, decodePacket } from "./packet.ts";
import { SimNetwork } from "./sim/network.ts";

const text = (s: string) => new TextEncoder().encode(s);
const read = (b: Uint8Array) => new TextDecoder().decode(b);

/** A line of nodes 0.1 apart with range 0.15: each node only hears its neighbours. */
function line(n: number, opts: { lossRate?: number } = {}) {
  const net = new SimNetwork({ range: 0.15, seed: 3, ...opts });
  const nodes = Array.from({ length: n }, (_, i) => new MeshNode(createIdentity(), net.add(i * 0.1, 0), { now: net.now }));
  const inbox = nodes.map(() => [] as Delivered[]);
  nodes.forEach((node, i) => node.onMessage((m) => inbox[i]!.push(m)));
  return { net, nodes, inbox };
}

test("a message crosses six hops and comes back with a receipt", () => {
  const { net, nodes, inbox } = line(7);
  const receipts: string[] = [];
  nodes[0]!.onReceipt((id) => receipts.push(id));
  const id = nodes[0]!.send(nodes[6]!.identity.publicKey, text("over the hill"));
  net.runUntil(net.time + 5_000);
  assert.equal(inbox[6]!.length, 1);
  assert.equal(read(inbox[6]![0]!.payload), "over the hill");
  assert.equal(inbox[6]![0]!.hops, 6);
  assert.equal(inbox[6]![0]!.from, nodes[0]!.id);
  for (let i = 1; i < 6; i++) assert.equal(inbox[i]!.length, 0, `relay ${i} must not deliver`);
  assert.deepEqual(receipts, [id]);
  assert.deepEqual(nodes[0]!.pending(), []);
});

test("duplicates are delivered once", () => {
  const net = new SimNetwork({ range: 0.5, seed: 4 });
  // A diamond: two paths from a to d.
  const [a, b, c, d] = [net.add(0, 0), net.add(0.3, 0.3), net.add(0.3, -0.3), net.add(0.6, 0)].map(
    (t) => new MeshNode(createIdentity(), t, { now: net.now }),
  );
  const got: Delivered[] = [];
  d!.onMessage((m) => got.push(m));
  a!.send(d!.identity.publicKey, text("once"));
  net.runUntil(net.time + 2_000);
  assert.equal(got.length, 1);
  assert.ok(d!.stats.dropped.duplicate >= 1);
  void b;
  void c;
});

test("ttl limits reach", () => {
  const { net, nodes, inbox } = line(6);
  nodes[0]!.send(nodes[5]!.identity.publicKey, text("short"), 3);
  net.runUntil(net.time + 5_000);
  assert.equal(inbox[5]!.length, 0);
});

test("store-and-forward: a node that comes online later still gets the message", () => {
  const { net, nodes, inbox } = line(4);
  const t3 = net.transports[3]!;
  net.setOnline(t3, false);
  nodes[0]!.send(nodes[3]!.identity.publicKey, text("while you were out"));
  net.runUntil(net.time + 60_000);
  assert.equal(inbox[3]!.length, 0);
  net.setOnline(t3, true);
  net.runUntil(net.time + 5_000);
  assert.equal(inbox[3]!.length, 1);
  assert.deepEqual(nodes[0]!.pending(), []);
});

test("a relay offline in the middle: message waits, then crosses", () => {
  const { net, nodes, inbox } = line(5);
  net.setOnline(net.transports[2]!, false);
  nodes[0]!.send(nodes[4]!.identity.publicKey, text("bridge"));
  net.runUntil(net.time + 30_000);
  assert.equal(inbox[4]!.length, 0);
  net.setOnline(net.transports[2]!, true);
  net.runUntil(net.time + 5_000);
  assert.equal(inbox[4]!.length, 1);
});

test("receipts clear the message from relays' stores", () => {
  const { net, nodes } = line(4);
  nodes[0]!.send(nodes[3]!.identity.publicKey, text("done"));
  net.runUntil(net.time + 5_000);
  // Each node keeps only the receipt itself.
  for (const n of nodes) assert.ok(n.storedCount <= 1, `${n.storedCount} stored`);
});

test("forged and tampered packets are dropped and do not block the real one", () => {
  const { net, nodes, inbox } = line(2);
  const mallory = createIdentity();
  const victim = nodes[1]!;
  const real = buildPacket(nodes[0]!.identity, victim.identity.publicKey, text("real"), { timestamp: net.time });
  // Mallory replays the real id with her own content but the sender's key.
  const forged = decodePacket(encodePacket(buildPacket(mallory, victim.identity.publicKey, text("fake"), { msgId: real.msgId, timestamp: net.time })));
  forged.src = nodes[0]!.identity.publicKey;
  net.transports[0]!.send("1", encodePacket(forged));
  net.runUntil(net.time + 1_000);
  assert.equal(victim.stats.dropped["bad-signature"], 1);
  net.transports[0]!.send("1", encodePacket(real));
  net.runUntil(net.time + 1_000);
  assert.equal(inbox[1]!.length, 1);
  assert.equal(read(inbox[1]![0]!.payload), "real");
});

test("old and future-dated packets are dropped", () => {
  const { net, nodes, inbox } = line(2);
  const dst = nodes[1]!.identity.publicKey;
  net.transports[0]!.send("1", encodePacket(buildPacket(nodes[0]!.identity, dst, text("old"), { timestamp: net.time - 7 * 3_600_000 })));
  net.transports[0]!.send("1", encodePacket(buildPacket(nodes[0]!.identity, dst, text("future"), { timestamp: net.time + 3_600_000 })));
  net.runUntil(net.time + 1_000);
  assert.equal(inbox[1]!.length, 0);
  assert.equal(nodes[1]!.stats.dropped.expired, 1);
  assert.equal(nodes[1]!.stats.dropped.future, 1);
});

test("one source cannot flood past the rate limit", () => {
  const net = new SimNetwork({ range: 0.15, seed: 5 });
  const a = new MeshNode(createIdentity(), net.add(0, 0), { now: net.now });
  const b = new MeshNode(createIdentity(), net.add(0.1, 0), { now: net.now, ratePerMinute: 10, rateBurst: 20 });
  let got = 0;
  b.onMessage(() => got++);
  for (let i = 0; i < 100; i++) a.broadcast(text(`spam ${i}`));
  net.runUntil(net.time + 1_000);
  assert.equal(got, 20);
  assert.equal(b.stats.dropped["rate-limited"], 80);
});

test("broadcast reaches every node and gets no receipts", () => {
  const { net, nodes, inbox } = line(5);
  nodes[2]!.broadcast(text("hello all"));
  net.runUntil(net.time + 5_000);
  for (const i of [0, 1, 3, 4]) assert.equal(inbox[i]!.length, 1, `node ${i}`);
  assert.equal(inbox[2]!.length, 0);
  assert.deepEqual(nodes[2]!.pending(), []);
});

test("ttl upgrade: a copy with more hops left is forwarded again, but not re-delivered", () => {
  // Line a-b-c. b first gets a copy with ttl 0 (cannot go further), then a fresh copy with ttl 5.
  const { net, nodes, inbox } = line(3);
  const [a, b, c] = nodes;
  const p = buildPacket(a!.identity, c!.identity.publicKey, text("detour"), { ttl: 5, timestamp: net.time });
  net.transports[0]!.send("1", encodePacket({ ...p, ttl: 0, hops: 5 }));
  net.runUntil(net.time + 1_000);
  assert.equal(inbox[2]!.length, 0, "ttl-0 copy must stop at b");
  net.transports[0]!.send("1", encodePacket(p));
  net.runUntil(net.time + 1_000);
  assert.equal(inbox[2]!.length, 1, "fresh copy reaches c");
  assert.equal(b!.stats.upgrades, 1);
  // Same or lower ttl again is a plain duplicate.
  net.transports[0]!.send("1", encodePacket(p));
  net.runUntil(net.time + 1_000);
  assert.equal(inbox[2]!.length, 1);
  assert.ok(b!.stats.dropped.duplicate >= 1);
});
