/**
 * CUMULUS_STORE=gateway with CUMULUS_ROWS=wallet,quota, end to end: the real Mail app wired the way
 * vercel.ts wires it, with a gateway that calls the same SQL functions the nexus-store edge function
 * calls, on a fresh database with the Supabase migrations applied. Wallets, transfers and storage
 * meters live in cumulus_rows and their documents are never written; two servers spending one balance
 * at once can't both succeed. Skipped unless CID_TEST_PG_URL is set (the PostgreSQL CI job sets it).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import type { Entry } from "@infinitum/firmament";
import { Ledger, generateSigner, type Signer } from "@infinitum/firmament";
import { createCumulus, emptyCumulusStores, toSnapshot } from "@infinitum/cumulus";
import { VirtualAuthenticator } from "../../../packages/cid/src/testing/virtual-authenticator.ts";
import { ConflictError, RemoteState, type DocRow, type NexusGateway } from "../../spectre/src/server/remote.ts";
import { cidStorageFromEnv, suiteDocuments } from "../../spectre/src/server/cid-store.ts";
import { createMailApp } from "./app.ts";

const url = process.env.CID_TEST_PG_URL;
const root = join(import.meta.dirname, "../../..");

describe("Wallet and quota rows through the gateway (CUMULUS_ROWS=wallet,quota)", { skip: url ? false : "set CID_TEST_PG_URL to run" }, async () => {
  const { default: pg } = await import("pg");
  const dbName = `rows_gateway_${process.pid}`;
  let admin: InstanceType<typeof pg.Pool>;
  let pool: InstanceType<typeof pg.Pool>;
  let server: ReturnType<typeof createServer>;
  let base = "";
  let signer: Signer;

  // What the nexus-store edge function does, straight to SQL.
  let onRead: (ops: unknown[]) => Promise<void> = async () => {};
  const gateway = (): NexusGateway => ({
    async load(since, versions) {
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
    async readRows(ops) {
      const r = (await pool.query("SELECT public.cid_read($1::jsonb) AS r", [JSON.stringify(ops)])).rows[0].r as unknown[];
      await onRead(ops);
      return r;
    },
  });

  /** One server: its own RemoteState and suite on the shared database, wired like vercel.ts. */
  const host = (origin: string) => {
    const g = gateway();
    const stores = emptyCumulusStores();
    const storage = cidStorageFromEnv({ CUMULUS_STORE: "gateway", CUMULUS_ROWS: "wallet,quota" }, g);
    const state = new RemoteState(g, suiteDocuments(storage, stores));
    state.metricsLog = null;
    state.participants.push(storage.participant!);
    state.rows = storage.rows!;
    const ledger = new Ledger(state.ledgerStore, { authorizedSigners: [signer.publicKey] });
    const suite = createCumulus({ ledger, signer, rpId: "localhost", origins: [origin], stores, mailOrigin: origin, repository: storage.repository, repositories: storage.repositories });
    return { state, suite };
  };

  before(async () => {
    admin = new pg.Pool({ connectionString: url, max: 1 });
    for (const role of ["anon", "authenticated", "service_role"]) {
      await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} NOLOGIN; END IF; END $$`);
    }
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    const u = new URL(url!);
    u.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: u.toString(), max: 8 });
    pool.on("error", () => {});
    for (const f of ["20261104_nexus_store.sql", "20261113_cumulus_id_rows.sql", "20261115_cumulus_rows_wallet_quota.sql", "20261116_cumulus_rows_mail.sql", "20261117_cumulus_rows_mail_counts.sql", "20261118_cumulus_rows_lock_order.sql", "20261119_cumulus_rows_mail_due.sql", "20261120_cumulus_rows_compare.sql"]) {
      await pool.query(readFileSync(join(root, "supabase/migrations", f), "utf8"));
    }
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    base = `http://localhost:${port}`;
    signer = generateSigner();
    const { state, suite } = host(base);
    const app = createMailApp({ suite, publicDir: join(import.meta.dirname, "..", "public"), origin: base, secureCookies: false, noTimers: true, transaction: (fn) => state.transaction(fn) });
    server = app.server();
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  });
  after(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`).catch(() => admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`));
    await admin?.end();
  });

  const call = (cookie: { v: string }) => async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-cumulus": "1", cookie: cookie.v }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    const set = res.headers.get("set-cookie");
    if (set) cookie.v = set.split(";")[0]!;
    const text = await res.text();
    let data: any = text;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, data };
  };

  it("signs up and sends mail with the wallet and storage meter in rows, never in documents", async () => {
    const c = call({ v: "" });
    const auth = new VirtualAuthenticator();
    const a = await c("POST", "/api/auth/signup", { username: "rowan" });
    assert.equal(a.status, 200, JSON.stringify(a.data));
    const reg = await c("POST", "/api/auth/signup/finish", { cid: a.data.cid, response: auth.create({ challenge: a.data.options.challenge, origin: base, rpId: "localhost" }) });
    assert.equal(reg.status, 200, JSON.stringify(reg.data));
    const signIn = await c("POST", "/api/auth/signin/finish", { response: auth.get({ credentialId: reg.data.options.allowCredentials[0].id, challenge: reg.data.options.challenge, origin: base }) });
    assert.equal(signIn.status, 200, JSON.stringify(signIn.data));
    const sent = await c("POST", "/api/send", { to: "rowan@cumuluscloud.app", subject: "Note to self", body: "Rows work." });
    assert.equal(sent.status, 200, JSON.stringify(sent.data));
    const st = await c("GET", "/api/state");
    assert.match(st.data.quota.label, /of 15/);

    assert.equal((await pool.query("SELECT count(*)::int AS n FROM cumulus_rows.wallet_accounts WHERE cid = $1", [a.data.cid])).rows[0].n, 1);
    assert.ok(Number((await pool.query("SELECT mail_bytes FROM cumulus_rows.quota_usage WHERE cid = $1", [a.data.cid])).rows[0].mail_bytes) > 0);
    const docs = (await pool.query("SELECT id FROM public.nexus_docs")).rows.map((r) => r.id);
    for (const id of ["cid", "firm-wallet", "cumulus-quota"]) assert.ok(!docs.includes(id), `${id} document never written (have ${docs.join(", ")})`);
    assert.ok(docs.includes("cumulus-mail"), "mail stays a document in gateway mode");
  });

  it("two servers spending one balance at once: one payment goes through, the other is refused", async () => {
    const one = host(base);
    const two = host(base);
    const [alex, sam, lee] = await one.state.transaction(async () => [
      await one.suite.cid.createAccount({ username: "alex" }),
      await one.suite.cid.createAccount({ username: "sam" }),
      await one.suite.cid.createAccount({ username: "lee" }),
    ]);
    await one.state.transaction(() => one.suite.credit(alex.cid, "USDC", "10", "Deposit"));
    // Each server waits after reading Alex's wallet until the other has read it too, so both start
    // from the same balance (a re-run after a conflict doesn't wait again).
    let arrived = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((r) => (release = r));
    onRead = async (ops) => {
      if (!(ops as { op: string; cid?: string }[]).some((o) => o.op === "walletAccount" && o.cid === alex.cid)) return;
      if (++arrived === 2) release();
      if (arrived <= 2) await Promise.race([bothRead, new Promise((r) => setTimeout(r, 2000))]);
    };
    const pay = (h: ReturnType<typeof host>, to: string) =>
      h.state.transaction(() => h.suite.pay(alex.cid, to, "USDC", "7", "race")).then(() => "sent", (e) => (e as { code?: string }).code ?? String(e));
    const outcomes = (await Promise.all([pay(one, "sam@cumuluscloud.app"), pay(two, "lee@cumuluscloud.app")])).sort();
    onRead = async () => {};
    assert.ok(arrived >= 3, "both read the same balance, and the loser read it again on its re-run");
    assert.deepEqual(outcomes, ["insufficient_funds", "sent"]);
    const balance = await one.state.transaction(() => one.suite.wallets.balances(alex.cid));
    assert.equal(balance.USDC, "3", "never spent twice");
    const transfers = (await pool.query("SELECT count(*)::int AS n FROM cumulus_rows.wallet_transfers WHERE from_cid = $1", [alex.cid])).rows[0].n;
    assert.equal(transfers, 1);
    assert.ok(sam && lee);
  });

  it("two servers filling one storage quota at once: the second upload is refused, never both", async () => {
    const one = host(base);
    const two = host(base);
    const mira = await one.state.transaction(() => one.suite.cid.createAccount({ username: "mira" }));
    let arrived = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((r) => (release = r));
    onRead = async (ops) => {
      if (!(ops as { op: string; cid?: string }[]).some((o) => o.op === "quotaUsage" && o.cid === mira.cid)) return;
      if (++arrived === 2) release();
      if (arrived <= 2) await Promise.race([bothRead, new Promise((r) => setTimeout(r, 2000))]);
    };
    const upload = (h: ReturnType<typeof host>) =>
      h.state.transaction(() => h.suite.quota.charge(mira.cid, "cloud", 10_000_000_000)).then(() => "stored", (e) => (e as { code?: string }).code ?? String(e));
    const outcomes = (await Promise.all([upload(one), upload(two)])).sort();
    onRead = async () => {};
    assert.ok(arrived >= 3, "both read the same usage, and the loser read it again on its re-run");
    assert.deepEqual(outcomes, ["quota_exceeded", "stored"]);
    const used = Number((await pool.query("SELECT cloud_bytes FROM cumulus_rows.quota_usage WHERE cid = $1", [mira.cid])).rows[0].cloud_bytes);
    assert.equal(used, 10_000_000_000, "15 GB is never overspent");
  });

  it("compare_with_documents: the wallet and quota rows match the documents after the copy, and a change is reported", async () => {
    const signer2 = generateSigner();
    const before = createCumulus({ ledger: new Ledger(undefined, { authorizedSigners: [signer2.publicKey] }), signer: signer2, rpId: "localhost", origins: [base] });
    const zed = await before.cid.createAccount({ username: "zedd" });
    await before.credit(zed.cid, "USDC", "9", "Deposit");
    await before.cloud.put("a.txt", zed.cid, 1234);
    await before.quota.setExtraGb(zed.cid, 2);
    await pool.query("INSERT INTO public.nexus_docs (id, version, data) VALUES ('firm-wallet', 1, $1), ('cumulus-quota', 1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data",
      [JSON.stringify(toSnapshot(before.stores.wallet)), JSON.stringify(toSnapshot(before.stores.quota))]);
    await pool.query("SELECT cumulus_rows.refresh_from_documents()");
    const compare = async () => (await pool.query("SELECT cumulus_rows.compare_with_documents(array['wallet', 'quota']) AS r")).rows[0].r;
    const same = await compare();
    assert.equal(same.same, true, JSON.stringify(same));
    assert.ok(same.counts.wallets.rows >= 1 && same.counts.quotas.rows >= 1);
    await pool.query("UPDATE cumulus_rows.quota_usage SET cloud_bytes = cloud_bytes + 1 WHERE cid = $1", [zed.cid]);
    assert.deepEqual((await compare()).differences.quotas.changed, [zed.cid]);
  });
});

