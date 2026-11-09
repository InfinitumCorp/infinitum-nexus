import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { CumulusTunnel, TunnelStore } from "./tunnel.ts";
import { PostOffice, PostOfficeStore } from "./postoffice.ts";
import { sealMailStore, openMailStore } from "./at-rest.ts";

describe("Cumulus Tunnel", () => {
  it("seals for the recipient, proves the sender, and nobody else can open it", () => {
    const t = new CumulusTunnel({ masterKey: randomBytes(32) });
    for (const cid of ["alex", "leah", "eve"]) t.ensure(cid);
    const env = t.seal("alex", ["leah"], { body: "the notes" });
    assert.ok(!JSON.stringify(env).includes("the notes"), "ciphertext only");
    const opened = t.open<{ body: string }>("leah", env);
    assert.equal(opened.payload.body, "the notes");
    assert.equal(opened.from, "alex");
    assert.equal(opened.verified, true);
    assert.throws(() => t.open("eve", env), /wasn't sealed/);
  });

  it("rejects an envelope that was altered or re-addressed", () => {
    const t = new CumulusTunnel({ masterKey: randomBytes(32) });
    for (const cid of ["alex", "leah", "eve"]) t.ensure(cid);
    const env = t.seal("alex", ["leah"], { body: "pay 10" });
    const flipped = Buffer.from(env.ct, "base64");
    flipped[0] ^= 1;
    assert.throws(() => t.open("leah", { ...env, ct: flipped.toString("base64") }), /signature/);
    assert.throws(() => t.open("leah", { ...env, from: "eve" }), /signature/, "can't claim another sender");
  });

  it("keeps private keys wrapped: the same master key reopens, a different one can't", () => {
    const key = randomBytes(32);
    const store = new TunnelStore();
    const a = new CumulusTunnel({ store, masterKey: key });
    a.ensure("alex");
    a.ensure("leah");
    const env = a.seal("alex", ["leah"], { body: "hi" });
    assert.ok(!JSON.stringify([...store.keys.values()]).includes("PRIVATE"));
    const restarted = new CumulusTunnel({ store: structuredClone(store), masterKey: key });
    assert.equal(restarted.open<{ body: string }>("leah", env).payload.body, "hi");
    const wrong = new CumulusTunnel({ store: structuredClone(store), masterKey: randomBytes(32) });
    assert.throws(() => wrong.open("leah", env), /different master key/);
    assert.equal(a.fingerprint("alex"), restarted.fingerprint("alex"));
    assert.match(a.fingerprint("alex"), /^[0-9A-F]{4}( [0-9A-F]{4}){5}$/);
  });

  it("delivers Cumulus mail through the tunnel and marks it verified", async () => {
    const po = new PostOffice({ tunnel: new CumulusTunnel({ masterKey: randomBytes(32) }) });
    po.provision({ cid: "a", address: "alex@cumuluscloud.app" });
    po.provision({ cid: "b", address: "leah@cumuluscloud.app" });
    const r = await po.send("a", { to: "leah@cumuluscloud.app", subject: "Notes", body: "In Cloud.", attachments: [{ name: "n.pdf", size: 10 }] });
    const got = po.view("b").messages.find((m) => m.subject === "Notes")!;
    assert.equal(got.body, "In Cloud.\n\nalex\nalex@cumuluscloud.app");
    assert.equal(got.attachments?.[0]?.name, "n.pdf");
    assert.deepEqual(got.tunnel, { verified: true, fingerprint: po.fingerprint("a") });
    assert.equal(po.message("a", r.id)?.tunnel?.verified, true);

    const out = await po.send("a", { to: "priya@vyral.london", subject: "Outside", body: "x" });
    assert.equal(po.message("a", out.id)?.tunnel, undefined, "mail leaving Cumulus isn't claimed as tunnelled");
  });

  it("signs as the mailbox owner, not the demo account", async () => {
    const po = new PostOffice();
    po.provision({ cid: "b", address: "leah@cumuluscloud.app", name: "Leah Okonkwo" });
    po.provision({ cid: "c", address: "sam@cumuluscloud.app", name: "Sam" });
    await po.send("b", { to: "sam@cumuluscloud.app", subject: "Hi", body: "Hello Sam." });
    const got = po.view("c").messages.find((m) => m.subject === "Hi");
    assert.equal(got?.body, "Hello Sam.\n\nLeah Okonkwo\nleah@cumuluscloud.app");
  });

  it("writes mailboxes sealed at rest and opens them again", async () => {
    const key = randomBytes(32);
    const tunnel = new CumulusTunnel({ masterKey: key });
    const po = new PostOffice({ tunnel });
    po.provision({ cid: "a", address: "alex@cumuluscloud.app" });
    po.provision({ cid: "b", address: "leah@cumuluscloud.app" });
    await po.send("a", { to: "leah@cumuluscloud.app", subject: "Secret plans", body: "Meet at noon." });

    const onDisk = sealMailStore(po.store, tunnel);
    const json = JSON.stringify([...onDisk.mailboxes.values()]);
    assert.ok(!json.includes("Secret plans") && !json.includes("Meet at noon"), "no plaintext on disk");
    assert.ok(json.includes("leah@cumuluscloud.app"), "routing metadata stays readable");
    assert.equal(po.view("b").messages[0]?.subject, "Secret plans", "the live store isn't touched");

    const loaded = structuredClone(onDisk) as PostOfficeStore;
    const reopened = new CumulusTunnel({ store: structuredClone(tunnel.store), masterKey: key });
    assert.equal(openMailStore(loaded, reopened), 0);
    assert.equal(loaded.mailboxes.get("b")!.messages[0]!.body, "Meet at noon.\n\nalex\nalex@cumuluscloud.app");

    const locked = structuredClone(onDisk) as PostOfficeStore;
    const wrongKey = new CumulusTunnel({ store: structuredClone(tunnel.store), masterKey: randomBytes(32) });
    assert.ok(openMailStore(locked, wrongKey) > 0);
    const again = sealMailStore(locked, wrongKey);
    const kept = again.mailboxes.get("b")!.messages[0] as unknown as { sealed?: unknown };
    assert.deepEqual(kept.sealed, (onDisk.mailboxes.get("b")!.messages[0] as unknown as { sealed?: unknown }).sealed, "a locked message keeps its original envelope");
  });
});
