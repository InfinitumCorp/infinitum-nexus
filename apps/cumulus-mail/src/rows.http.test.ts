/**
 * Cumulus://Mail with CUMULUS_STORE=postgres and CUMULUS_ROWS=mail,wallet,quota, end to end: the real
 * Mail app wired the way vercel.ts wires it (RemoteState for the ledger and the remaining documents,
 * every request in one transaction). Sign up, use the mailbox, send mail: the mailbox, messages,
 * wallet and storage meter live in rows, and their documents are never written. Skipped unless
 * CID_TEST_PG_URL is set (the PostgreSQL CI job sets it).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import type { Entry } from "@infinitum/firmament";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { migrateCid } from "@infinitum/cid";
import { createCumulus, emptyCumulusStores, migrateProductRows } from "@infinitum/cumulus";
import { VirtualAuthenticator } from "../../../packages/cid/src/testing/virtual-authenticator.ts";
import { ConflictError, RemoteState, type DocRow, type NexusGateway } from "../../spectre/src/server/remote.ts";
import { cidStorageFromEnv, suiteDocuments } from "../../spectre/src/server/cid-store.ts";
import { createMailApp } from "./app.ts";

const url = process.env.CID_TEST_PG_URL;
const root = join(import.meta.dirname, "../../..");

describe("Mail, Wallet and Quota on rows (CUMULUS_ROWS)", { skip: url ? false : "set CID_TEST_PG_URL to run" }, async () => {
  const { default: pg } = await import("pg");
  const dbName = `mail_product_rows_${process.pid}`;
  let admin: InstanceType<typeof pg.Pool>;
  let pool: InstanceType<typeof pg.Pool>;
  let server: ReturnType<typeof createServer>;
  let base = "";
  let dbUrl = "";

  before(async () => {
    admin = new pg.Pool({ connectionString: url, max: 1 });
    for (const role of ["anon", "authenticated", "service_role"]) {
      await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} NOLOGIN; END IF; END $$`);
    }
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    const u = new URL(url!);
    u.pathname = `/${dbName}`;
    dbUrl = u.toString();
    pool = new pg.Pool({ connectionString: dbUrl, max: 6 });
    pool.on("error", () => {});
    await pool.query(readFileSync(join(root, "supabase/migrations", "20261104_nexus_store.sql"), "utf8"));
    await migrateCid(pool, "cumulus");
    await migrateProductRows(pool, ["mail", "wallet", "quota"], "cumulus");

    const gateway: NexusGateway = {
      async load(since, versions) {
        const entries = (await pool.query("SELECT entry FROM public.nexus_ledger WHERE seq > $1 ORDER BY seq", [since])).rows.map((r) => r.entry as Entry);
        const docs = (await pool.query("SELECT id, version, data FROM public.nexus_docs")).rows
          .filter((d) => Number(d.version) !== (versions[d.id] ?? 0))
          .map((d) => ({ id: d.id, version: Number(d.version), data: d.data }) as DocRow);
        return { entries, docs };
      },
      async commit(entries, docs) {
        try {
          return (await pool.query("SELECT public.nexus_commit($1::jsonb, $2::jsonb) AS v", [JSON.stringify(entries), JSON.stringify(docs)])).rows[0].v as Record<string, number>;
        } catch (err) {
          if (String((err as Error).message).includes("nexus_conflict")) throw new ConflictError();
          throw err;
        }
      },
    };

    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    base = `http://localhost:${port}`;
    const signer = generateSigner();
    const stores = emptyCumulusStores();
    const storage = cidStorageFromEnv({ CUMULUS_STORE: "postgres", CID_DATABASE_URL: dbUrl, CID_DATABASE_SCHEMA: "cumulus", CUMULUS_ROWS: "mail,wallet,quota" }, gateway);
    const state = new RemoteState(gateway, suiteDocuments(storage, stores));
    state.metricsLog = null;
    state.participants.push(storage.participant!);
    const ledger = new Ledger(state.ledgerStore, { authorizedSigners: [signer.publicKey] });
    const suite = createCumulus({ ledger, signer, rpId: "localhost", origins: [base], stores, mailOrigin: base, repository: storage.repository, repositories: storage.repositories });
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

  const browser = () => {
    let cookie = "";
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-cumulus": "1", cookie }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0]!;
      const text = await res.text();
      let data: any = text;
      try { data = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, data };
    };
    return { call };
  };
  const count = async (table: string, where = "true", params: unknown[] = []) =>
    Number((await pool.query(`SELECT count(*)::int AS n FROM cumulus.${table} WHERE ${where}`, params)).rows[0].n);

  it("signs up and uses Mail with mailboxes, wallets and storage in rows, and no product documents", async () => {
    const b = browser();
    const auth = new VirtualAuthenticator();
    const a = await b.call("POST", "/api/auth/signup", { username: "rowan" });
    assert.equal(a.status, 200, JSON.stringify(a.data));
    const reg = await b.call("POST", "/api/auth/signup/finish", { cid: a.data.cid, response: auth.create({ challenge: a.data.options.challenge, origin: base, rpId: "localhost" }) });
    assert.equal(reg.status, 200, JSON.stringify(reg.data));
    const signIn = await b.call("POST", "/api/auth/signin/finish", { response: auth.get({ credentialId: reg.data.options.allowCredentials[0].id, challenge: reg.data.options.challenge, origin: base }) });
    assert.equal(signIn.status, 200, JSON.stringify(signIn.data));

    const st = await b.call("GET", "/api/state");
    assert.equal(st.status, 200, JSON.stringify(st.data));
    assert.equal(st.data.me.email, "rowan@cumuluscloud.app");
    assert.ok(st.data.messages.some((m: any) => /Welcome/.test(m.subject)), "provisioned on sign-up");
    const sent = await b.call("POST", "/api/send", { to: "rowan@cumuluscloud.app, priya@example.com", subject: "Note to self", body: "Rows work." });
    assert.equal(sent.status, 200, JSON.stringify(sent.data));
    const after = await b.call("GET", "/api/state");
    assert.equal(after.data.messages.filter((m: any) => m.subject === "Note to self").length, 2, "in Sent and in the inbox");

    assert.equal(await count("mail_mailboxes", "cid = $1", [a.data.cid]), 1);
    assert.equal(await count("mail_addresses", "address = 'rowan@cumuluscloud.app'"), 1);
    assert.ok((await count("mail_messages", "cid = $1", [a.data.cid])) >= 3);
    assert.equal(await count("mail_outbound"), 1, "the outside recipient is queued in a row");
    assert.equal(await count("wallet_accounts", "cid = $1", [a.data.cid]), 1);
    assert.ok((await pool.query("SELECT mail_bytes FROM cumulus.quota_usage WHERE cid = $1", [a.data.cid])).rows[0].mail_bytes > 0, "storage is charged in a row");
    const docs = (await pool.query("SELECT id FROM public.nexus_docs ORDER BY id")).rows.map((r) => r.id);
    for (const id of ["cid", "cumulus-mail", "firm-wallet", "cumulus-quota"]) assert.ok(!docs.includes(id), `${id} document never written (have ${docs.join(", ")})`);
  });
});
