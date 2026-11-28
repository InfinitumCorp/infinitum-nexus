/**
 * +SPCTR with CUMULUS_STORE=gateway and CUMULUS_ROWS=mail,wallet,quota (vercel.ts, as deployed): an
 * account made here gets its mailbox, wallet and storage meter as rows, the same rows Mail reads, and
 * the mail, wallet and quota documents are neither read nor written. Runs the SQL the nexus-store edge
 * function calls, on a fresh database with the Supabase migrations applied. Skipped unless
 * CID_TEST_PG_URL is set.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { generateSigner, type Entry } from "@infinitum/firmament";
import { VirtualAuthenticator } from "../../../../packages/cid/src/testing/virtual-authenticator.ts";
import { ConflictError, type DocRow, type NexusGateway } from "./remote.ts";

const url = process.env.CID_TEST_PG_URL;
const root = join(import.meta.dirname, "../../../..");
// Every Supabase migration from the nexus store on, in order.
const MIGRATIONS = readdirSync(join(root, "supabase/migrations")).filter((f) => f >= "20261104" && !f.includes("lbrnth") && !f.includes("data_platform")).sort();

describe("+SPCTR keeps Mail, Wallet and the quota as rows (CUMULUS_ROWS)", { skip: url ? false : "set CID_TEST_PG_URL to run" }, async () => {
  const { default: pg } = await import("pg");
  const dbName = `spectre_rows_${process.pid}`;
  let admin: InstanceType<typeof pg.Pool>;
  let pool: InstanceType<typeof pg.Pool>;
  let server: Server;
  let base = "";
  const docsWritten = new Set<string>();

  const gateway: NexusGateway = {
    async load(since, versions) {
      const entries = (await pool.query("SELECT entry FROM public.nexus_ledger WHERE seq > $1 ORDER BY seq", [since])).rows.map((r) => r.entry as Entry);
      const docs = (await pool.query("SELECT id, version, data FROM public.nexus_docs")).rows
        .filter((d) => Number(d.version) !== (versions[d.id] ?? 0))
        .map((d) => ({ id: d.id, version: Number(d.version), data: d.data }) as DocRow);
      return { entries, docs };
    },
    async commit(entries, docs, rows) {
      for (const d of docs) docsWritten.add(d.id);
      try {
        const r = rows?.length
          ? await pool.query("SELECT public.nexus_commit_cid($1::jsonb, $2::jsonb, $3::jsonb) AS v", [JSON.stringify(entries), JSON.stringify(docs), JSON.stringify(rows)])
          : await pool.query("SELECT public.nexus_commit($1::jsonb, $2::jsonb) AS v", [JSON.stringify(entries), JSON.stringify(docs)]);
        return r.rows[0].v as Record<string, number>;
      } catch (err) {
        if (String((err as Error).message).includes("nexus_conflict")) throw new ConflictError();
        throw new Error(`commit failed: ${(err as Error).message}`);
      }
    },
    async readRows(ops) {
      return (await pool.query("SELECT public.cid_read($1::jsonb) AS r", [JSON.stringify(ops)])).rows[0].r as unknown[];
    },
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
    pool = new pg.Pool({ connectionString: u.toString(), max: 6 });
    pool.on("error", () => {});
    for (const f of MIGRATIONS) await pool.query(readFileSync(join(root, "supabase/migrations", f), "utf8"));

    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    base = `http://localhost:${port}`;
    Object.assign(process.env, {
      SPECTRE_ORIGIN: base,
      FIRMAMENT_SIGNER_KEY: generateSigner().exportPrivateKey(),
      CUMULUS_STORE: "gateway",
      CUMULUS_ROWS: "mail,wallet,quota",
    });
    const { default: handler, useGateway } = await import("./vercel.ts");
    useGateway(gateway);
    server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  });
  after(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`).catch(() => admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`));
    await admin?.end();
  });

  const call = async (method: string, path: string, body?: unknown, cookie?: string) => {
    const res = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-spectre": "1", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json().catch(() => null)) as any, headers: res.headers };
  };

  it("a sign-up here lands in the rows Mail reads, and no mail, wallet or quota document is written", async () => {
    const auth = new VirtualAuthenticator();
    const s = await call("POST", "/api/auth/signup", { username: "rowan" });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    const f = await call("POST", "/api/auth/signup/finish", { cid: s.body.cid, response: auth.create({ challenge: s.body.options.challenge, origin: base, rpId: "localhost" }) });
    const signin = await call("POST", "/api/auth/signin/finish", { response: auth.get({ credentialId: [...auth.credentials.keys()][0], challenge: f.body.options.challenge, origin: base }) });
    const cookie = signin.headers.get("set-cookie")!.split(";")[0];
    const me = await call("GET", "/api/me", undefined, cookie);
    assert.equal(me.status, 200);
    assert.equal(me.body.mailAddress, "rowan@cumuluscloud.app");
    assert.equal(me.body.cumulus.mail.unread, 1, "the welcome message");

    const cid = s.body.cid as string;
    const one = async (sql: string) => (await pool.query(sql, [cid])).rows[0].n as number;
    assert.equal(await one("SELECT count(*)::int AS n FROM cumulus_rows.mail_mailboxes WHERE cid = $1"), 1, "the mailbox is a row");
    assert.equal(await one("SELECT count(*)::int AS n FROM cumulus_rows.mail_messages WHERE cid = $1"), 1, "the welcome message is a row");
    assert.equal(await one("SELECT count(*)::int AS n FROM cumulus_rows.wallet_accounts WHERE cid = $1"), 1, "the wallet is a row");
    for (const doc of ["cumulus-mail", "firm-wallet", "cumulus-quota"]) assert.ok(!docsWritten.has(doc), `${doc} isn't written`);
    const claimed = (await pool.query("SELECT product FROM cumulus_rows.claims ORDER BY product")).rows.map((r) => r.product);
    assert.deepEqual(claimed.filter((p) => p !== "cid"), [], "nothing to hand over yet: no documents existed");
  });
});
