/**
 * The Mail app as deployed (vercel.ts handler, with the CUMULUS_STORE and CUMULUS_ROWS values from
 * cloudflare.config.ts), on a database with every Supabase migration applied and the documents already
 * holding data, as in production: the first request claims each document (ID only recorded, since its
 * rows match), a sign-up lands in rows and no document is written, and Drive works on rows.
 * Skipped unless CID_TEST_PG_URL is set.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Ledger, generateSigner, type Entry } from "@infinitum/firmament";
import { createCumulus, toSnapshot } from "@infinitum/cumulus";
import { VirtualAuthenticator } from "../../../packages/cid/src/testing/virtual-authenticator.ts";
import { ConflictError, type DocRow, type NexusGateway } from "../../spectre/src/server/remote.ts";
import { MemoryFileStore } from "./files.ts";

const url = process.env.CID_TEST_PG_URL;
const root = join(import.meta.dirname, "../../..");
const MIGRATIONS = readdirSync(join(root, "supabase/migrations")).filter((f) => f >= "20261104" && !f.includes("lbrnth") && !f.includes("data_platform")).sort();
const config = readFileSync(join(import.meta.dirname, "../cloudflare.config.ts"), "utf8");
const setting = (name: string) => config.match(new RegExp(`${name}: bindings\\.text\\("([^"]*)"\\)`))?.[1];

describe("Mail with the production storage settings", { skip: url ? false : "set CID_TEST_PG_URL to run" }, async () => {
  const { default: pg } = await import("pg");
  const dbName = `mail_prod_config_${process.pid}`;
  let admin: InstanceType<typeof pg.Pool>;
  let pool: InstanceType<typeof pg.Pool>;
  let server: Server;
  let base = "";
  const docsWritten = new Set<string>();
  const signer = generateSigner();

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

  let existing: { cid: string };

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

    // Production today: documents with accounts and mail, ID rows already copied (and matching).
    const yesterday = createCumulus({ ledger: new Ledger(undefined, { authorizedSigners: [signer.publicKey] }), signer, rpId: "localhost", origins: ["http://localhost"] });
    existing = await yesterday.cid.createAccount({ username: "earlybird" });
    await yesterday.mail.send(existing.cid, { to: "earlybird@cumuluscloud.app", subject: "Before the switch", body: "x" });
    const docs: [string, object][] = [["cid", yesterday.stores.cid], ["cumulus-mail", yesterday.stores.mail], ["firm-wallet", yesterday.stores.wallet], ["cumulus-quota", yesterday.stores.quota]];
    for (const [id, store] of docs) await pool.query("INSERT INTO public.nexus_docs (id, version, data) VALUES ($1, 3, $2)", [id, JSON.stringify(toSnapshot(store))]);
    await pool.query("SELECT cumulus_id.refresh_from_document()");

    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    base = `http://localhost:${port}`;
    Object.assign(process.env, {
      MAIL_ORIGIN: base,
      FIRMAMENT_SIGNER_KEY: signer.exportPrivateKey(),
      CUMULUS_STORE: setting("CUMULUS_STORE"),
      CUMULUS_ROWS: setting("CUMULUS_ROWS"),
    });
    const { default: handler, useGateway, useFileStore } = await import("./vercel.ts");
    useGateway(gateway);
    useFileStore(new MemoryFileStore());
    server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  });
  after(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`).catch(() => admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`));
    await admin?.end();
  });

  let cookie = "";
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-cumulus": "1", cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!;
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  const count = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0].n as number;

  it("the settings are the ones this test expects", () => {
    assert.equal(setting("CUMULUS_STORE"), "gateway");
    assert.equal(setting("CUMULUS_ROWS"), "mail,wallet,quota,drive");
  });

  it("a sign-up and mail land in rows; no document is written; Drive works on rows", async () => {
    const auth = new VirtualAuthenticator();
    const a = await call("POST", "/api/auth/signup", { username: "afterswitch" });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const b = await call("POST", "/api/auth/signup/finish", { cid: a.body.cid, response: auth.create({ challenge: a.body.options.challenge, origin: base, rpId: "localhost" }) });
    await call("POST", "/api/auth/signin/finish", { response: auth.get({ credentialId: b.body.options.allowCredentials[0].id, challenge: b.body.options.challenge, origin: base }) });
    const cid = a.body.cid as string;
    assert.equal((await call("POST", "/api/send", { to: "earlybird@cumuluscloud.app", subject: "Hello from rows", body: "hi" })).status, 200);
    const folder = await call("POST", "/api/drive/folders", { name: "Plans" });
    assert.equal(folder.status, 200, JSON.stringify(folder.body));

    assert.equal(await count("SELECT count(*)::int AS n FROM cumulus_id.cid_accounts WHERE cid = $1", [cid]), 1, "the account is a row");
    assert.equal(await count("SELECT count(*)::int AS n FROM cumulus_rows.mail_mailboxes WHERE cid = $1", [cid]), 1, "the mailbox is a row");
    assert.equal(await count("SELECT count(*)::int AS n FROM cumulus_rows.mail_messages WHERE cid = $1 AND data->>'subject' = 'Hello from rows'", [existing.cid]), 1, "the mail was delivered into rows");
    assert.equal(await count("SELECT count(*)::int AS n FROM cumulus_rows.wallet_accounts WHERE cid = $1", [cid]), 1, "the wallet is a row");
    assert.equal(await count("SELECT count(*)::int AS n FROM cumulus_rows.drive_items WHERE owner = $1 AND data->>'name' = 'Plans'", [cid]), 1, "the folder is a row");
    for (const doc of ["cid", "cumulus-mail", "firm-wallet", "cumulus-quota", "cumulus-workspace"]) assert.ok(!docsWritten.has(doc), `${doc} isn't written`);

    // A file sent to someone: the database knows it's attached, so deleting the sender's copy keeps it.
    const up = await fetch(`${base}/api/files?name=a.txt`, { method: "POST", headers: { "content-type": "text/plain", "x-cumulus": "1", cookie }, body: "hello" });
    const file = (await up.json()) as { id: string; name: string; size: number; type: string };
    assert.equal((await call("POST", "/api/send", { to: "earlybird@cumuluscloud.app", subject: "With a file", body: ".", attachments: [file] })).status, 200);
    const inUse = async (id: string) => ((await pool.query("SELECT public.cid_read($1::jsonb) AS r", [JSON.stringify([{ op: "mailAttachmentInUse", id }])])).rows[0].r as boolean[])[0];
    assert.equal(await inUse(file.id), true);
    assert.equal(await inUse(`u/${cid}/00000000-0000-4000-8000-000000000000`), false);
    const sentCopy = (await pool.query("SELECT id FROM cumulus_rows.mail_messages WHERE cid = $1 AND data->>'subject' = 'With a file'", [cid])).rows[0].id;
    await call("POST", "/api/move", { id: sentCopy, folder: "trash" });
    assert.equal((await call("POST", "/api/remove", { id: sentCopy })).status, 200);
    assert.equal(await inUse(file.id), true, "earlybird's copy still has it, so it stays");
  });
  it("after the first requests: each document was claimed once, and what was there before is in the rows", async () => {
    const claims = (await pool.query("SELECT product, copied FROM cumulus_rows.claims ORDER BY product")).rows;
    assert.deepEqual(claims.map((c) => c.product), ["cid", "mail", "quota", "wallet"], "drive has no document yet, so nothing is recorded for it");
    assert.deepEqual(claims.find((c) => c.product === "cid").copied, { matched: true });
    assert.equal(await count("SELECT count(*)::int AS n FROM cumulus_rows.mail_messages WHERE cid = $1 AND data->>'subject' = 'Before the switch'", [existing.cid]), 2);
  });

});
