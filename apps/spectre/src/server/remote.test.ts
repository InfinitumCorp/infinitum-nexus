import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { CidService, CidStore } from "@infinitum/cid";
import { SpectreCRM, emptyStore } from "../core/crm.ts";
import { HttpGateway, RemoteState, MemoryGateway } from "./remote.ts";

/** Two serverless instances sharing one database. */
function instance(gateway: MemoryGateway, signer = generateSigner()) {
  const cidStore = new CidStore();
  const spectreStore = emptyStore();
  const state = new RemoteState(gateway, { cid: cidStore, spectre: spectreStore });
  const ledger = new Ledger(state.ledgerStore, { authorizedSigners: [signer.publicKey] });
  const cid = new CidService({ ledger, signer, rpId: "localhost", origins: ["http://localhost"], store: cidStore });
  const crm = new SpectreCRM({ ledger, signer, store: spectreStore });
  return { state, cid, crm, ledger, signer };
}

describe("Hosted state (serverless instances sharing Supabase)", () => {
  it("calls fetch as a plain function so Workers do not throw Illegal invocation", async () => {
    let seen: unknown = "unset";
    const fetchImpl = function (this: unknown, _url: string | URL | Request, init?: RequestInit) {
      seen = this;
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.op, "load");
      return Promise.resolve(new Response(JSON.stringify({ entries: [], docs: [] }), { status: 200 }));
    } as typeof fetch;
    const gateway = new HttpGateway("https://store.example/nexus", "key", fetchImpl);
    assert.deepEqual(await gateway.load(-1, {}), { entries: [], docs: [] });
    assert.equal(seen, undefined);
  });

  it("saves changes and lets another instance see them", async () => {
    const db = new MemoryGateway();
    const a = instance(db);
    const b = instance(db, a.signer);
    const account = await a.state.transaction(() => a.cid.createAccount({ username: "alex" }));
    await a.state.transaction(() => a.crm.addCompany(account.cid, account.cid, { name: "Northwind" }));

    await b.state.transaction(async () => {
      assert.equal((await b.cid.getAccount(account.cid)).username, "alex");
      assert.equal(b.crm.list("companies", account.cid)[0].name, "Northwind");
    });
    assert.equal(db.entries.length, 2);
    assert.deepEqual(await b.ledger.verify(), { ok: true, length: 2 });
  });

  it("re-runs a request when another instance saved first, losing nothing", async () => {
    const db = new MemoryGateway();
    const a = instance(db);
    const b = instance(db, a.signer);
    const acct = await a.state.transaction(() => a.cid.createAccount({ username: "alex" }));
    await b.state.sync();

    // B prepares a change from stale state while A saves; B's commit conflicts and is re-run.
    let runs = 0;
    await a.state.transaction(() => a.crm.addCompany(acct.cid, acct.cid, { name: "From A" }));
    await b.state.transaction(async () => {
      runs++;
      return b.crm.addCompany(acct.cid, acct.cid, { name: "From B" });
    });
    // B synced at the start of its transaction, so no conflict here; force one explicitly:
    const c = instance(db, a.signer);
    await c.state.sync();
    await a.state.transaction(() => a.crm.addCompany(acct.cid, acct.cid, { name: "From A again" }));
    const originalSync = c.state.sync.bind(c.state);
    let first = true;
    c.state.sync = async () => { if (first) { first = false; return; } return originalSync(); }; // skip first sync = stale
    await c.state.transaction(async () => { runs++; return c.crm.addCompany(acct.cid, acct.cid, { name: "From C" }); });

    const names = (await (async () => { const d = instance(db, a.signer); await d.state.sync(); return d.crm.list("companies", acct.cid).map((x) => x.name).sort(); })());
    assert.deepEqual(names, ["From A", "From A again", "From B", "From C"]);
    assert.equal(runs, 3, "C's request ran twice: once stale, once fresh");
    const check = instance(db, a.signer);
    await check.state.sync();
    assert.equal((await check.ledger.verify()).ok, true);
  });

  it("keeps what a failed request recorded, like a failed sign-in audit entry", async () => {
    const db = new MemoryGateway();
    const a = instance(db);
    const acct = await a.state.transaction(() => a.cid.createAccount({ username: "alex" }));
    await assert.rejects(a.state.transaction(async () => {
      await a.ledger.append({ type: "audit", product: "cid", actor: acct.cid, subject: acct.cid, payload: { event: "signin.failed" } }, a.signer);
      throw new Error("Wrong passkey");
    }), /Wrong passkey/);
    assert.equal(db.entries.length, 2);
    assert.equal(db.entries[1].payload.event, "signin.failed");
    assert.deepEqual(await a.ledger.verify(), { ok: true, length: 2 });
  });

  it("drops unsaved changes when the database can't be reached", async () => {
    const db = new MemoryGateway();
    const a = instance(db);
    const acct = await a.state.transaction(() => a.cid.createAccount({ username: "alex" }));
    const realCommit = db.commit.bind(db);
    db.commit = async () => { throw new Error("Data store error 503"); };
    await assert.rejects(a.state.transaction(() => a.crm.addCompany(acct.cid, acct.cid, { name: "Unsaved" })), /503/);
    assert.equal(a.crm.list("companies", acct.cid).length, 0, "memory matches the database again");
    db.commit = realCommit;
    await a.state.transaction(() => a.crm.addCompany(acct.cid, acct.cid, { name: "Saved" }));
    assert.deepEqual(a.crm.list("companies", acct.cid).map((c) => c.name), ["Saved"]);
    assert.deepEqual(await a.ledger.verify(), { ok: true, length: 2 });
  });

  it("gives up with a clear message if conflicts keep happening", async () => {
    const db = new MemoryGateway();
    const a = instance(db);
    const acct = await a.state.transaction(() => a.cid.createAccount({ username: "alex" }));
    const { ConflictError } = await import("./remote.ts");
    db.commit = async () => { throw new ConflictError(); };
    await assert.rejects(a.state.transaction(() => a.crm.addCompany(acct.cid, acct.cid, { name: "X" })), /busy/);
    assert.equal(a.crm.list("companies", acct.cid).length, 0);
  });

  it("doesn't write anything for read-only requests", async () => {
    const db = new MemoryGateway();
    const a = instance(db);
    await a.state.transaction(() => a.cid.createAccount({ username: "alex" }));
    const before = db.docs.get("cid")!.version;
    await a.state.transaction(async () => a.cid.socialProvidersEnabled());
    assert.equal(db.docs.get("cid")!.version, before);
  });
});
