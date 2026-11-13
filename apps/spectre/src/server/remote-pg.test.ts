/**
 * Cumulus://ID rows in Postgres, saved together with the rest of a request (relational storage
 * phase 4). RemoteState re-runs a request when another server saved first; the Postgres writes of
 * the discarded attempt must vanish with it. Runs on PGlite (Postgres in-process).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { CidService, PgCidRepository, PgRequestScope, migrateCid, type PgPoolClient, type Queryable } from "@infinitum/cid";
import { ConflictError, MemoryGateway, RemoteState, type TransactionParticipant } from "./remote.ts";

/** A one-connection "pool" over PGlite (multi-statement text without parameters goes through exec). */
function pglitePool(pg: PGlite): Queryable & { connect(): Promise<PgPoolClient> } {
  const query = async (text: string, params?: unknown[]) => {
    if (!params?.length && text.includes(";")) {
      const results = await pg.exec(text);
      return { rows: (results.at(-1)?.rows ?? []) as any[] };
    }
    const r = await pg.query(text, params as any[]);
    return { rows: r.rows as any[], rowCount: r.affectedRows ?? null };
  };
  return { query, connect: async () => ({ query, release() {} }) };
}

async function hosted() {
  const pg = new PGlite();
  const pool = pglitePool(pg);
  await migrateCid(pool);
  const scope = new PgRequestScope(pool);
  const gateway = new MemoryGateway();
  const other = { notes: new Map<string, string>() }; // a document that stays in nexus_docs
  const state = new RemoteState(gateway, { other });
  state.metricsLog = null;
  state.participants = [scope];
  const signer = generateSigner();
  const ledger = new Ledger(state.ledgerStore, { authorizedSigners: [signer.publicKey] });
  const cid = new CidService({ ledger, signer, rpId: "localhost", origins: ["http://localhost"], repository: new PgCidRepository({ db: scope }) });
  const count = async (table: string) => Number((await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n);
  return { pg, state, gateway, cid, ledger, count, other };
}

describe("RemoteState with Cumulus://ID on Postgres", () => {
  it("a sign-up re-run after a save conflict creates the account once", async () => {
    const h = await hosted();
    const realCommit = h.gateway.commit.bind(h.gateway);
    let conflicts = 0;
    h.gateway.commit = async (entries, docs) => {
      if (conflicts++ === 0) throw new ConflictError();
      return realCommit(entries, docs);
    };
    let attempts = 0;
    const account = await h.state.transaction(async () => {
      attempts++;
      return h.cid.createAccount({ username: "alex" });
    });
    assert.equal(attempts, 2, "the request ran twice");
    assert.equal(await h.count("cid_accounts"), 1);
    assert.equal(await h.cid.cidForUsername("alex"), account.cid, "the second attempt's account is the one that exists");
    assert.deepEqual(await h.ledger.verify(), { ok: true, length: 1 });
  });

  it("leaves no rows when the ledger save fails or conflicts every time", async () => {
    const h = await hosted();
    h.gateway.commit = async () => { throw new Error("Data store error 503"); };
    await assert.rejects(h.state.transaction(() => h.cid.createAccount({ username: "sam" })), /503/);
    h.gateway.commit = async () => { throw new ConflictError(); };
    await assert.rejects(h.state.transaction(() => h.cid.createAccount({ username: "sam" })), /busy/);
    assert.equal(await h.count("cid_accounts"), 0);
    assert.equal(await h.cid.cidForUsername("sam"), undefined);
  });

  it("keeps what a failed request recorded, like the document store does", async () => {
    const h = await hosted();
    await assert.rejects(h.state.transaction(async () => {
      await h.cid.createAccount({ username: "kim" });
      throw new Error("the handler failed after writing");
    }), /handler failed/);
    assert.ok(await h.cid.cidForUsername("kim"), "committed with the ledger entry that records it");
    assert.deepEqual(await h.ledger.verify(), { ok: true, length: 1 });
  });

  it("sees its own writes inside the request, and a later request sees them too", async () => {
    const h = await hosted();
    const { cid: id } = await h.state.transaction(async () => {
      const a = await h.cid.createAccount({ username: "lee" });
      assert.equal((await h.cid.getAccount(a.cid)).username, "lee");
      return a;
    });
    await h.state.transaction(async () => assert.equal((await h.cid.getAccount(id)).username, "lee"));
  });
});

describe("RemoteState participants", () => {
  const recorder = () => {
    const log: string[] = [];
    const p: TransactionParticipant = {
      begin: async () => void log.push("begin"),
      commit: async () => void log.push("commit"),
      rollback: async () => void log.push("rollback"),
    };
    return { log, p };
  };

  it("commit after the ledger save; roll back before a re-run", async () => {
    const gateway = new MemoryGateway();
    const doc = { items: new Map<string, number>() };
    const state = new RemoteState(gateway, { doc });
    state.metricsLog = null;
    const { log, p } = recorder();
    state.participants = [p];
    const realCommit = gateway.commit.bind(gateway);
    let n = 0;
    gateway.commit = async (e, d) => {
      log.push("save");
      if (n++ === 0) throw new ConflictError();
      return realCommit(e, d);
    };
    await state.transaction(async () => void doc.items.set("x", 1));
    assert.deepEqual(log, ["begin", "save", "rollback", "begin", "save", "commit"]);
  });

  it("counts a participant that fails to commit after the ledger was saved", async () => {
    const gateway = new MemoryGateway();
    const state = new RemoteState(gateway, { doc: { items: new Map<string, number>() } });
    const lines: string[] = [];
    state.metricsLog = (l) => lines.push(l);
    state.participants = [{ begin: async () => {}, commit: async () => { throw new Error("pg down"); }, rollback: async () => {} }];
    await assert.rejects(state.transaction(async () => 1), /pg down/);
    assert.equal(state.stats.participantFailures, 1);
    assert.ok(lines.some((l) => JSON.parse(l).reason === "participant-commit-failed"));
  });
});

describe("HttpGateway and Cumulus://ID rows", () => {
  it("sends row lookups as cid.read, and row writes with the commit only when there are some", async () => {
    const { HttpGateway } = await import("./remote.ts");
    const bodies: any[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      return Response.json(body.op === "cid.read" ? { results: [null] } : { cid: 2 });
    }) as unknown as typeof fetch;
    const g = new HttpGateway("https://store.example/nexus-store", "k".repeat(40), fetchImpl);
    assert.deepEqual(await g.readRows([{ op: "account", cid: "cid_a" }]), [null]);
    await g.commit([], [], [{ kind: "account", id: "cid_a", data: null }]);
    await g.commit([], []);
    assert.deepEqual(bodies.map((b) => [b.op, "cid" in b]), [["cid.read", false], ["commit", true], ["commit", false]]);
    assert.deepEqual(bodies[0].ops, [{ op: "account", cid: "cid_a" }]);
  });
});
