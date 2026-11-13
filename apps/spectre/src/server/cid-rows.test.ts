/**
 * CUMULUS_STORE=gateway end to end on real Postgres: the Supabase migrations (nexus-store and
 * cumulus_id rows) applied to a fresh database, a gateway that calls the same SQL functions the
 * nexus-store edge function calls, and RemoteState running requests from two "servers".
 * Skipped unless CID_TEST_PG_URL is set (the PostgreSQL CI job sets it).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Entry } from "@infinitum/firmament";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { CidService, CidStore } from "@infinitum/cid";
import { cidStorageFromEnv } from "./cid-store.ts";
import { ConflictError, RemoteState, type DocRow, type NexusGateway } from "./remote.ts";

const url = process.env.CID_TEST_PG_URL;
const root = join(import.meta.dirname, "../../../..");

describe("Cumulus://ID rows through the nexus-store SQL", { skip: url ? false : "set CID_TEST_PG_URL to run" }, async () => {
  const { default: pg } = await import("pg");
  const dbName = `cid_rows_${process.pid}`;
  let admin: InstanceType<typeof pg.Pool>;
  let pool: InstanceType<typeof pg.Pool>;

  before(async () => {
    admin = new pg.Pool({ connectionString: url, max: 1 });
    for (const role of ["anon", "authenticated", "service_role"]) {
      await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} NOLOGIN; END IF; END $$`);
    }
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    const u = new URL(url!);
    u.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: u.toString(), max: 6 });
    for (const f of ["20261104_nexus_store.sql", "20261113_cumulus_id_rows.sql"]) {
      await pool.query(readFileSync(join(root, "supabase/migrations", f), "utf8"));
    }
  });
  after(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  /** What the nexus-store edge function does, straight to SQL. */
  const sqlGateway = (): NexusGateway => ({
    async load(since: number, versions: Record<string, number>) {
      const entries = (await pool.query("SELECT entry FROM public.nexus_ledger WHERE seq > $1 ORDER BY seq", [since])).rows.map((r) => r.entry as Entry);
      const docs = (await pool.query("SELECT id, version, data FROM public.nexus_docs")).rows
        .filter((d) => Number(d.version) !== (versions[d.id] ?? 0))
        .map((d) => ({ id: d.id, version: Number(d.version), data: d.data }) as DocRow);
      return { entries, docs };
    },
    async commit(entries, docs, rows) {
      try {
        const r = rows?.length
          ? await pool.query("SELECT public.nexus_commit_cid($1::jsonb, $2::jsonb, $3::jsonb) AS v", [JSON.stringify(entries), JSON.stringify(docs), JSON.stringify(rows)])
          : await pool.query("SELECT public.nexus_commit($1::jsonb, $2::jsonb) AS v", [JSON.stringify(entries), JSON.stringify(docs)]);
        return r.rows[0].v as Record<string, number>;
      } catch (err) {
        if (String((err as Error).message).includes("nexus_conflict")) throw new ConflictError();
        throw err;
      }
    },
    async readRows(ops: unknown[]) {
      return (await pool.query("SELECT public.cid_read($1::jsonb) AS r", [JSON.stringify(ops)])).rows[0].r as unknown[];
    },
  });

  /** One hosted server: RemoteState over the gateway, CidService on gateway-mode rows. */
  const server = (signer = generateSigner()) => {
    const gateway = sqlGateway();
    const storage = cidStorageFromEnv({ CUMULUS_STORE: "gateway" }, gateway);
    const state = new RemoteState(gateway, { other: { notes: new Map<string, string>() } });
    state.metricsLog = null;
    state.participants.push(storage.participant!);
    state.rows = storage.rows!;
    const ledger = new Ledger(state.ledgerStore, { authorizedSigners: [signer.publicKey] });
    const cid = new CidService({ ledger, signer, rpId: "localhost", origins: ["http://localhost"], repository: storage.repository });
    return { state, cid, ledger, signer, repo: storage.repository! };
  };
  const count = async (table: string) => Number((await pool.query(`SELECT count(*)::int AS n FROM cumulus_id.${table}`)).rows[0].n);

  it("saves an account and its session as rows, in the same commit as the ledger entry", async () => {
    const a = server();
    const account = await a.state.transaction(() => a.cid.createAccount({ username: "alex" }));
    const issued = (await a.state.transaction(() => (a.cid as any).issueSession(account.cid, "browser", "passkey"))) as { token: string };
    assert.equal(await count("cid_accounts"), 1);
    assert.equal(await count("cid_sessions"), 1);
    const b = server(a.signer); // another server: reads everything back from the rows
    const who = await b.state.transaction(() => b.cid.authenticate(issued.token));
    assert.equal(who?.account.username, "alex");
    assert.deepEqual(await b.ledger.verify(), { ok: true, length: 2 });
  });

  it("of two servers taking the same single-use item, one wins and the other re-runs and finds it gone", async () => {
    const a = server();
    const b = server(a.signer);
    await a.state.transaction(() => a.repo.putOneTime("challenge", "race", { value: "v", purpose: "login", expiresAt: 9e15 }));
    const results: unknown[] = [];
    let raced = false;
    await b.state.transaction(async () => {
      const got = await b.repo.takeOneTime("challenge", "race");
      if (!raced) {
        raced = true;
        await a.state.transaction(() => a.repo.takeOneTime("challenge", "race")); // a commits first
      }
      results.push(got);
    });
    assert.equal(results.length, 2, "b ran twice");
    assert.ok(results[0], "first attempt saw it");
    assert.equal(results[1], undefined, "the re-run doesn't");
    assert.equal(b.state.stats.conflicts, 1);
  });

  it("a username claimed by another server between read and commit makes the re-run say it's taken", async () => {
    const a = server();
    const b = server(a.signer);
    let raced = false;
    await assert.rejects(b.state.transaction(async () => {
      if (!raced) {
        raced = true;
        assert.equal(await b.repo.cidForUsername("kim"), undefined);
        await a.state.transaction(() => a.cid.createAccount({ username: "kim" }));
      }
      return b.cid.createAccount({ username: "kim" });
    }), /taken/);
    assert.equal(Number((await pool.query("SELECT count(*)::int AS n FROM cumulus_id.cid_accounts WHERE username = 'kim'")).rows[0].n), 1);
  });

  it("a failed save leaves no rows (all or nothing with the ledger)", async () => {
    const a = server();
    const before = await count("cid_accounts");
    const gateway = sqlGateway();
    const storage = cidStorageFromEnv({ CUMULUS_STORE: "gateway" }, { ...gateway, commit: async () => { throw new Error("Data store error 503"); } });
    const state = new RemoteState({ ...gateway, commit: async () => { throw new Error("Data store error 503"); } }, {});
    state.metricsLog = null;
    state.participants.push(storage.participant!);
    state.rows = storage.rows!;
    const ledger = new Ledger(state.ledgerStore, { authorizedSigners: [a.signer.publicKey] });
    const cid = new CidService({ ledger, signer: a.signer, rpId: "localhost", origins: ["http://localhost"], repository: storage.repository });
    await assert.rejects(state.transaction(() => cid.createAccount({ username: "nobody" })), /503/);
    assert.equal(await count("cid_accounts"), before);
  });

  it("refresh_from_document copies a document-mode store exactly, and gateway mode signs its people in", async () => {
    // A document-mode CidService writes the `cid` document as hosts do today.
    const signer = generateSigner();
    const store = new CidStore();
    const docCid = new CidService({ ledger: new Ledger(undefined, { authorizedSigners: [signer.publicKey] }), signer, rpId: "localhost", origins: ["http://localhost"], store });
    const lee = await docCid.createAccount({ username: "lee" });
    const issued = await (docCid as any).issueSession(lee.cid, "phone", "passkey");
    await docCid.grant(lee.cid, "LBRNTH", ["repo:read"]);
    const snapshot: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(store)) snapshot[k] = v instanceof Map ? { __map: [...v.entries()] } : v;
    await pool.query("INSERT INTO public.nexus_docs (id, version, data) VALUES ('cid', 1, $1) ON CONFLICT (id) DO UPDATE SET data = excluded.data", [JSON.stringify(snapshot)]);

    const copied = (await pool.query("SELECT cumulus_id.refresh_from_document() AS c")).rows[0].c;
    assert.deepEqual(copied, { accounts: 1, authenticators: 0, sessions: 1, grants: 1, identities: 0, federation: 0, orgs: 0 });
    const g = server(signer);
    assert.equal((await g.state.transaction(() => g.cid.authenticate(issued.token)))?.account.cid, lee.cid);
    assert.equal(await g.state.transaction(() => g.cid.can(lee.cid, "LBRNTH", "repo:read")), true);
  });

  it("refuses a write whose data names a different row than the one it checks", async () => {
    const forged = [{ kind: "account", id: "cid_checked", expect: null, data: { cid: "cid_other", username: "forged", mailAddress: "f@x", handle: "@f", createdAt: "t", entitlements: {} } }];
    await assert.rejects(pool.query("SELECT public.nexus_commit_cid('[]'::jsonb, '[]'::jsonb, $1::jsonb)", [JSON.stringify(forged)]), /does not match its data/);
    assert.equal(Number((await pool.query("SELECT count(*)::int AS n FROM cumulus_id.cid_accounts WHERE username = 'forged'")).rows[0].n), 0);
  });

  it("only answers whitelisted lookups", async () => {
    await assert.rejects(pool.query(`SELECT public.cid_read('[{"op":"dropEverything"}]'::jsonb)`), /unknown op/);
    await assert.rejects(pool.query(`SELECT public.cid_read($1::jsonb)`, [JSON.stringify(Array.from({ length: 51 }, () => ({ op: "allAccounts" })))]), /1 to 50/);
  });
});
