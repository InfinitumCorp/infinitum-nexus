/**
 * Cumulus://Mail with CUMULUS_STORE=gateway, end to end before the switch (#196): the real Mail app,
 * wired the way vercel.ts wires it (RemoteState over the nexus-store gateway, every request in a
 * transaction), with a gateway that calls the same SQL functions the nexus-store edge function calls,
 * on a fresh Postgres database with the Supabase migrations applied. Sign up with a passkey, sign in,
 * open the mailbox, send mail, sign out: every account, key and session lives in cumulus_id rows and the
 * `cid` document is never written. Skipped unless CID_TEST_PG_URL is set (the PostgreSQL CI job sets it).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import type { Entry } from "@infinitum/firmament";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { createCumulus, emptyCumulusStores } from "@infinitum/cumulus";
import { VirtualAuthenticator } from "../../../packages/cid/src/testing/virtual-authenticator.ts";
import { ConflictError, RemoteState, type DocRow, type NexusGateway } from "../../spectre/src/server/remote.ts";
import { cidStorageFromEnv } from "../../spectre/src/server/cid-store.ts";
import { createMailApp } from "./app.ts";

const url = process.env.CID_TEST_PG_URL;
const root = join(import.meta.dirname, "../../..");

describe("Mail on Cumulus://ID rows (CUMULUS_STORE=gateway)", { skip: url ? false : "set CID_TEST_PG_URL to run" }, async () => {
  const { default: pg } = await import("pg");
  const dbName = `mail_rows_${process.pid}`;
  let admin: InstanceType<typeof pg.Pool>;
  let pool: InstanceType<typeof pg.Pool>;
  let server: ReturnType<typeof createServer>;
  let base = "";

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
    pool.on("error", () => {}); // the drop at the end terminates idle connections
    for (const f of ["20261104_nexus_store.sql", "20261113_cumulus_id_rows.sql", "20261115_cumulus_rows_wallet_quota.sql", "20261116_cumulus_rows_mail.sql", "20261117_cumulus_rows_mail_counts.sql", "20261118_cumulus_rows_lock_order.sql"]) {
      await pool.query(readFileSync(join(root, "supabase/migrations", f), "utf8"));
    }

    // What the nexus-store edge function does, straight to SQL.
    const gateway: NexusGateway = {
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
        return (await pool.query("SELECT public.cid_read($1::jsonb) AS r", [JSON.stringify(ops)])).rows[0].r as unknown[];
      },
    };

    // The same wiring as vercel.ts, minus the environment.
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    base = `http://localhost:${port}`;
    const signer = generateSigner();
    const stores = emptyCumulusStores();
    const cidStorage = cidStorageFromEnv({ CUMULUS_STORE: "gateway" }, gateway);
    const state = new RemoteState(gateway, { "cumulus-mail": stores.mail, "firm-wallet": stores.wallet, "cumulus-quota": stores.quota, "cumulus-suite": stores.suite });
    state.metricsLog = null;
    state.participants.push(cidStorage.participant!);
    state.rows = cidStorage.rows!;
    const ledger = new Ledger(state.ledgerStore, { authorizedSigners: [signer.publicKey] });
    const suite = createCumulus({ ledger, signer, rpId: "localhost", origins: [base], stores, mailOrigin: base, repository: cidStorage.repository });
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
  const rows = async (table: string, where = "true", params: unknown[] = []) =>
    Number((await pool.query(`SELECT count(*)::int AS n FROM cumulus_id.${table} WHERE ${where}`, params)).rows[0].n);

  it("signs up with a passkey, signs in, uses the mailbox and signs out, all on rows", async () => {
    const b = browser();
    const auth = new VirtualAuthenticator();
    const a = await b.call("POST", "/api/auth/signup", { username: "rowan" });
    assert.equal(a.status, 200, JSON.stringify(a.data));
    const reg = await b.call("POST", "/api/auth/signup/finish", { cid: a.data.cid, response: auth.create({ challenge: a.data.options.challenge, origin: base, rpId: "localhost" }) });
    assert.equal(reg.status, 200, JSON.stringify(reg.data));
    const signIn = await b.call("POST", "/api/auth/signin/finish", { response: auth.get({ credentialId: reg.data.options.allowCredentials[0].id, challenge: reg.data.options.challenge, origin: base }) });
    assert.equal(signIn.status, 200, JSON.stringify(signIn.data));

    assert.equal(await rows("cid_accounts", "username = $1", ["rowan"]), 1);
    assert.equal(await rows("cid_authenticators", "cid = $1", [a.data.cid]), 1);
    assert.equal(await rows("cid_sessions", "cid = $1 AND data->>'revokedAt' IS NULL", [a.data.cid]), 1);
    assert.equal(await rows("cid_pending", "kind = 'challenge'"), 0, "both sign-in challenges were used up");

    const st = await b.call("GET", "/api/state");
    assert.equal(st.status, 200, JSON.stringify(st.data));
    assert.equal(st.data.me.email, "rowan@cumuluscloud.app");
    assert.ok(st.data.messages.some((m: any) => /Welcome/.test(m.subject)), "provisioned on sign-up");
    assert.match(st.data.quota.label, /of 15/, "the storage meter is still in the response");
    const sent = await b.call("POST", "/api/send", { to: "rowan@cumuluscloud.app", subject: "Note to self", body: "Rows work." });
    assert.equal(sent.status, 200, JSON.stringify(sent.data));

    assert.equal((await pool.query("SELECT count(*)::int AS n FROM public.nexus_docs WHERE id = 'cid'")).rows[0].n, 0, "the cid document is never written");

    const out = await b.call("POST", "/api/auth/signout");
    assert.equal(out.status, 200, JSON.stringify(out.data));
    assert.equal(await rows("cid_sessions", "cid = $1 AND data->>'revokedAt' IS NULL", [a.data.cid]), 0, "signing out revokes the session row");
    assert.equal((await b.call("GET", "/api/state")).status, 401);
  });

  it("refuses a second account with the same username", async () => {
    const b = browser();
    const again = await b.call("POST", "/api/auth/signup", { username: "rowan" });
    assert.equal(again.status, 400);
    assert.equal(await rows("cid_accounts", "username = $1", ["rowan"]), 1);
  });
});
