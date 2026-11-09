import { test } from "node:test";
import assert from "node:assert/strict";
import { createIdentity, exportPublicKey, importPublicKey, pair } from "./pairing.ts";
import { SecureChannel } from "./channel.ts";
import { parseIntent } from "./intents.ts";
import { UsageMeter } from "./usage.ts";

function pairedChannels() {
  const wearable = createIdentity("eon-1");
  const phone = createIdentity("phone-1");
  const kw = pair(wearable, importPublicKey(exportPublicKey(phone)));
  const kp = pair(phone, importPublicKey(exportPublicKey(wearable)));
  return { kw, kp, w: new SecureChannel(kw), p: new SecureChannel(kp) };
}

test("both sides derive matching SAS, link id and crossed keys", () => {
  const { kw, kp } = pairedChannels();
  assert.equal(kw.sas, kp.sas);
  assert.match(kw.sas, /^\d{6}$/);
  assert.equal(kw.linkId, kp.linkId);
  assert.ok(kw.sendKey.equals(kp.receiveKey));
  assert.ok(kw.receiveKey.equals(kp.sendKey));
  assert.ok(!kw.sendKey.equals(kw.receiveKey));
});

test("an interceptor gets a different SAS", () => {
  const a = createIdentity("a");
  const b = createIdentity("b");
  const mitm = createIdentity("m");
  // A sits on a link with the interceptor; B's link with the interceptor has its own code.
  assert.notEqual(pair(a, mitm.publicKey).sas, pair(b, mitm.publicKey).sas);
  assert.notEqual(pair(a, mitm.publicKey).linkId, pair(a, b.publicKey).linkId);
});

test("refuses to pair with itself", () => {
  const a = createIdentity("a");
  assert.throws(() => pair(a, a.publicKey), /itself/);
});

test("frames round-trip in both directions", () => {
  const { w, p } = pairedChannels();
  assert.equal(p.openText(w.seal("text", "on my way")), "on my way");
  const voice = new Uint8Array([1, 2, 3, 250]);
  assert.deepEqual([...w.open(p.seal("voice", voice))], [...voice]);
});

test("replayed and reordered frames are rejected", () => {
  const { w, p } = pairedChannels();
  const f0 = w.seal("text", "one");
  const f1 = w.seal("text", "two");
  p.open(f1);
  assert.throws(() => p.open(f0), /replayed/);
  assert.throws(() => p.open(f1), /replayed/);
});

test("tampering with kind or ciphertext fails authentication", () => {
  const { w, p } = pairedChannels();
  const f = w.seal("text", "hello");
  assert.throws(() => p.open({ ...f, kind: "control" }));
  const bytes = Buffer.from(f.sealed, "base64");
  bytes[0] = bytes[0]! ^ 0xff;
  assert.throws(() => p.open({ ...f, sealed: bytes.toString("base64") }));
});

test("a frame cannot be opened by its own sender", () => {
  const { w } = pairedChannels();
  assert.throws(() => w.open(w.seal("text", "x")));
});

test("intents parse on device", () => {
  assert.deepEqual(parseIntent("Hey EON, call Mara."), { type: "call", contact: "Mara" });
  assert.deepEqual(parseIntent("E(O)N message ops desk saying landed safely"), {
    type: "message",
    contact: "ops desk",
    body: "landed safely",
  });
  assert.equal(parseIntent("read my messages").type, "read_messages");
  assert.deepEqual(parseIntent("unmute"), { type: "mute", on: false });
  assert.deepEqual(parseIntent("panic wipe"), { type: "wipe", requiresConfirmation: true });
  assert.equal(parseIntent("what's the weather").type, "unknown");
});

test("usage aggregate is withheld below the threshold and holds no content", () => {
  const m = new UsageMeter();
  for (let i = 0; i < 4; i++) {
    m.start(`s${i}`, 0);
    m.frame("voice");
    m.end(`s${i}`, 60_000);
  }
  assert.equal(m.aggregate(), null);
  m.start("s4", 0);
  m.end("s4", 30_000);
  const agg = m.aggregate();
  assert.deepEqual(agg, { sessionCount: 5, avgDuration: 54, framesByKind: { voice: 4, text: 0, control: 0 } });
  assert.throws(() => m.end("s4", 1), /not open/);
});
