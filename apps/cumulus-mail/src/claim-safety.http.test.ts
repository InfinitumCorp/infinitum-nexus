/**
 * The first-request claim never overwrites rows that hold something else, and a rollback hands the
 * document back (20261124_cumulus_rows_claim_safety.sql). Each case lost accounts or mail before.
 * Skipped unless CID_TEST_PG_URL is set.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Entry } from "@infinitum/firmament";
import { Ledger, generateSigner, type Signer } from "@infinitum/firmament";
import { createCumulus, emptyCumulusStores, toSnapshot } from "@infinitum/cumulus";
import { ConflictError, RemoteState, type DocRow, type NexusGateway } from "../../spectre/src/server/remote.ts";
import { cidStorageFromEnv, suiteDocuments } from "../../spectre/src/server/cid-store.ts";

const url = process.env.CID_TEST_PG_URL;
const root = join(import.meta.dirname, "../../..");
const ALL = ["20261104_nexus_store.sql", "20261113_cumulus_id_rows.sql", "20261114_cumulus_id_reverse.sql", "20261115_cumulus_rows_wallet_quota.sql",
  "20261116_cumulus_rows_mail.sql", "20261117_cumulus_rows_mail_counts.sql", "20261118_cumulus_rows_lock_order.sql", "20261119_cumulus_rows_mail_due.sql",
  "20261120_cumulus_rows_compare.sql", "20261121_cumulus_rows_claim.sql", "20261122_cumulus_rows_drive.sql", "20261123_cumulus_rows_drive_checks.sql",
  "20261124_cumulus_rows_claim_safety.sql"];
const mig = (f: string) => readFileSync(join(root, "supabase/migrations", f), "utf8");

describe("rows claims never overwrite rows that hold something else", { skip: url ? false : "set CID_TEST_PG_URL to run" }, async () => {
  const { default: pg } = await import("pg");
  let admin: any; let signer: Signer;
  before(async () => {
    admin = new pg.Pool({ connectionString: url!, max: 1 });
    for (const role of ["anon", "authenticated", "service_role"]) await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} NOLOGIN; END IF; END $$`);
    signer = generateSigner();
  });
  after(async () => { await admin?.end(); });
  const fresh = async (name: string, upto: number) => {
    const db = `claim_safety_${name}_${process.pid}`;
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`); await admin.query(`CREATE DATABASE ${db}`);
    const u = new URL(url!); u.pathname = `/${db}`;
    const pool = new pg.Pool({ connectionString: u.toString(), max: 6 }); pool.on("error", () => {});
    for (const f of ALL.slice(0, upto)) await pool.query(mig(f));
    return { pool, db, drop: async () => { await pool.end(); await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`); } };
  };
  const gw = (pool: any): NexusGateway => ({
    async load(since, versions) {
      const entries = (await pool.query("SELECT entry FROM public.nexus_ledger WHERE seq > $1 ORDER BY seq", [since])).rows.map((r: any) => r.entry as Entry);
      const docs = (await pool.query("SELECT id, version, data FROM public.nexus_docs")).rows.filter((d: any) => Number(d.version) !== (versions[d.id] ?? 0)).map((d: any) => ({ id: d.id, version: Number(d.version), data: d.data }) as DocRow);
      return { entries, docs };
    },
    async commit(entries, docs, rows) {
      try {
        const r = rows?.length ? await pool.query("SELECT public.nexus_commit_cid($1::jsonb, $2::jsonb, $3::jsonb) AS v", [JSON.stringify(entries), JSON.stringify(docs), JSON.stringify(rows)])
          : await pool.query("SELECT public.nexus_commit($1::jsonb, $2::jsonb) AS v", [JSON.stringify(entries), JSON.stringify(docs)]);
        return r.rows[0].v;
      } catch (err) { if (String((err as Error).message).includes("nexus_conflict")) throw new ConflictError(); throw new Error(`commit failed: ${(err as Error).message}`); }
    },
    async readRows(ops) { return (await pool.query("SELECT public.cid_read($1::jsonb) AS r", [JSON.stringify(ops)])).rows[0].r; },
  });
  const host = (pool: any, env: Record<string, string>, noClaim = false) => {
    const g = gw(pool); const stores = emptyCumulusStores();
    const storage = cidStorageFromEnv(env, g);
    const state = new RemoteState(g, suiteDocuments(storage, stores)); state.metricsLog = null;
    if (storage.participant) {
      if (noClaim) { const r = () => { (storage.repository as any).begin(); }; state.participants.push({ begin: async () => r(), commit: async () => r(), rollback: async () => r() }); }
      else state.participants.push(storage.participant);
    }
    if (storage.rows) state.rows = storage.rows;
    const ledger = new Ledger(state.ledgerStore, { authorizedSigners: [signer.publicKey] });
    const suite = createCumulus({ ledger, signer, rpId: "localhost", origins: ["http://localhost"], stores, repository: storage.repository, repositories: storage.repositories });
    return { state, suite };
  };
  const seedDoc = async (pool: any) => {
    const doc = host(pool, {}); // document mode
    return doc.state.transaction(() => doc.suite.cid.createAccount({ username: "ada" }));
  };
  const rowCount = async (pool: any) => (await pool.query("select count(*)::int n from cumulus_id.cid_accounts")).rows[0].n;

  const username = async (h: ReturnType<typeof host>, cid: string) =>
    h.state.transaction(async () => (await h.suite.cid.getAccount(cid).catch(() => null))?.username ?? null);

  it("rows written before claims existed, different from the document: the host refuses, nothing is replaced", async () => {
    const { pool, drop } = await fresh("differ", 9);
    try {
      await seedDoc(pool);
      await pool.query("select cumulus_id.refresh_from_document()"); // the manual switch, before claims existed
      const old = host(pool, { CUMULUS_STORE: "gateway" }, true); // a host from before claims
      const bob = await old.state.transaction(() => old.suite.cid.createAccount({ username: "bobby" }));
      for (const f of ALL.slice(9)) await pool.query(mig(f));

      const nu = host(pool, { CUMULUS_STORE: "gateway" });
      await assert.rejects(nu.state.transaction(async () => "served"), /rows for cid already hold data that differs/);
      assert.equal(await rowCount(pool), 2, "bobby's row is still there");
      // The operator keeps the rows: record the claim, and the host serves them.
      await pool.query("insert into cumulus_rows.claims (product, copied) values ('cid', '{}')");
      assert.equal(await username(nu, bob.cid), "bobby");
    } finally {
      await drop();
    }
  });

  it("rows that already match the document: the claim is recorded without copying", async () => {
    const { pool, drop } = await fresh("match", 9);
    try {
      const ada = await seedDoc(pool);
      await pool.query("select cumulus_id.refresh_from_document()");
      for (const f of ALL.slice(9)) await pool.query(mig(f));
      const nu = host(pool, { CUMULUS_STORE: "gateway" });
      assert.equal(await username(nu, ada.cid), "ada");
      const claim = (await pool.query("select copied from cumulus_rows.claims where product = 'cid'")).rows[0];
      assert.deepEqual(claim.copied, { matched: true });
    } finally {
      await drop();
    }
  });

  it("a rollback releases the claim: switching back copies what was written on the document meanwhile", async () => {
    const { pool, drop } = await fresh("rollback", ALL.length);
    try {
      await seedDoc(pool);
      const g1 = host(pool, { CUMULUS_STORE: "gateway" });
      await g1.state.transaction(async () => 1);
      await pool.query("select cumulus_id.restore_document()");
      const doc = host(pool, {});
      const dan = await doc.state.transaction(() => doc.suite.cid.createAccount({ username: "danny" }));
      const g2 = host(pool, { CUMULUS_STORE: "gateway" });
      assert.equal(await username(g2, dan.cid), "danny");
      assert.equal((await pool.query("select released_at from cumulus_rows.claims where product = 'cid'")).rows[0].released_at, null, "claimed again");
    } finally {
      await drop();
    }
  });

  it("no document yet: nothing is recorded, and the document is copied once it exists", async () => {
    const { pool, drop } = await fresh("nodoc", ALL.length);
    try {
      await seedDoc(pool);
      await pool.query("delete from public.nexus_docs where id = 'cumulus-mail'");
      const first = (await gw(pool).commit([], [], [{ kind: "claim", id: "mail" }])) as Record<string, unknown>;
      assert.deepEqual(first["claim:mail"], { noDocument: true });
      assert.equal((await pool.query("select count(*)::int n from cumulus_rows.claims where product = 'mail'")).rows[0].n, 0);
      await pool.query(`insert into public.nexus_docs (id, version, data) values ('cumulus-mail', 1, '{"mailboxes":{"__map":[["x",{"messages":[]}]]},"addresses":{"__map":[]},"outbound":{"__map":[]}}')`);
      const second = (await gw(pool).commit([], [], [{ kind: "claim", id: "mail" }])) as Record<string, any>;
      assert.equal(second["claim:mail"].claimed, true);
      assert.equal((await pool.query("select count(*)::int n from cumulus_rows.mail_mailboxes")).rows[0].n, 1);
    } finally {
      await drop();
    }
  });
});
