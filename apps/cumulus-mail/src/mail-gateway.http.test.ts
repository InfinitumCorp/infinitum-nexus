/**
 * CUMULUS_STORE=gateway with CUMULUS_ROWS=mail,wallet,quota, end to end: the real Mail app wired the way
 * vercel.ts wires it, with a gateway that calls the same SQL functions the nexus-store edge function
 * calls, on a fresh database with the Supabase migrations applied. Mailboxes, messages, addresses and
 * outbound mail live in cumulus_rows and the cumulus-mail document is never written; two deliveries to
 * one mailbox at once are both kept; an existing mail document is copied in with nothing lost.
 * Skipped unless CID_TEST_PG_URL is set (the PostgreSQL CI job sets it).
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

describe("Mail rows through the gateway (CUMULUS_ROWS=mail,wallet,quota)", { skip: url ? false : "set CID_TEST_PG_URL to run" }, async () => {
  const { default: pg } = await import("pg");
  const dbName = `mail_gateway_${process.pid}`;
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
        // The edge function answers any other database error with a plain 500 (no SQLSTATE).
        throw new Error(`commit failed: ${(err as Error).message}`);
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
    const storage = cidStorageFromEnv({ CUMULUS_STORE: "gateway", CUMULUS_ROWS: "mail,wallet,quota" }, g);
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
    for (const f of ["20261104_nexus_store.sql", "20261113_cumulus_id_rows.sql", "20261115_cumulus_rows_wallet_quota.sql", "20261116_cumulus_rows_mail.sql", "20261117_cumulus_rows_mail_counts.sql", ...(process.env.SKIP_LOCK_ORDER ? [] : ["20261118_cumulus_rows_lock_order.sql"]), "20261119_cumulus_rows_mail_due.sql"]) {
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

  it("signs up and uses Mail with mailboxes, messages and outbound mail in rows, and no product documents", async () => {
    const c = call({ v: "" });
    const auth = new VirtualAuthenticator();
    const a = await c("POST", "/api/auth/signup", { username: "rowan" });
    assert.equal(a.status, 200, JSON.stringify(a.data));
    const reg = await c("POST", "/api/auth/signup/finish", { cid: a.data.cid, response: auth.create({ challenge: a.data.options.challenge, origin: base, rpId: "localhost" }) });
    assert.equal(reg.status, 200, JSON.stringify(reg.data));
    const signIn = await c("POST", "/api/auth/signin/finish", { response: auth.get({ credentialId: reg.data.options.allowCredentials[0].id, challenge: reg.data.options.challenge, origin: base }) });
    assert.equal(signIn.status, 200, JSON.stringify(signIn.data));
    const st = await c("GET", "/api/state");
    assert.ok(st.data.messages.some((m: any) => /Welcome/.test(m.subject)), "provisioned on sign-up");
    const sent = await c("POST", "/api/send", { to: "rowan@cumuluscloud.app, priya@example.com", subject: "Note to self", body: "Rows work." });
    assert.equal(sent.status, 200, JSON.stringify(sent.data));
    const after = await c("GET", "/api/state");
    assert.equal(after.data.messages.filter((m: any) => m.subject === "Note to self").length, 2, "in Sent and in the inbox");
    const starred = after.data.messages.find((m: any) => m.subject === "Note to self" && m.folder === "inbox");
    assert.equal((await c("POST", "/api/star", { id: starred.id })).status, 200);
    assert.equal((await c("GET", "/api/state")).data.messages.find((m: any) => m.id === starred.id).starred, true);

    const n = async (sql: string, params: unknown[] = []) => Number((await pool.query(sql, params)).rows[0].n);
    assert.equal(await n("SELECT count(*)::int AS n FROM cumulus_rows.mail_mailboxes WHERE cid = $1", [a.data.cid]), 1);
    assert.ok((await n("SELECT count(*)::int AS n FROM cumulus_rows.mail_messages WHERE cid = $1", [a.data.cid])) >= 3);
    assert.equal(await n("SELECT count(*)::int AS n FROM cumulus_rows.mail_addresses WHERE address = 'rowan@cumuluscloud.app'"), 1);
    assert.equal(await n("SELECT count(*)::int AS n FROM cumulus_rows.mail_outbound"), 1);
    const docs = (await pool.query("SELECT id FROM public.nexus_docs")).rows.map((r) => r.id);
    for (const id of ["cid", "cumulus-mail", "firm-wallet", "cumulus-quota"]) assert.ok(!docs.includes(id), `${id} document never written (have ${docs.join(", ")})`);
  });

  it("two servers delivering to one mailbox at once: both messages are kept", async () => {
    const one = host(base);
    const two = host(base);
    const [sam, alex, lee] = await one.state.transaction(async () => [
      await one.suite.cid.createAccount({ username: "samwise" }),
      await one.suite.cid.createAccount({ username: "alexis" }),
      await one.suite.cid.createAccount({ username: "leeroy" }),
    ]);
    let arrived = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((r) => (release = r));
    onRead = async (ops) => {
      if (!(ops as { op: string; cid?: string }[]).some((o) => o.op === "mailbox" && o.cid === sam.cid)) return;
      if (++arrived === 2) release();
      if (arrived <= 2) await Promise.race([bothRead, new Promise((r) => setTimeout(r, 2000))]);
    };
    const send = (h: ReturnType<typeof host>, from: string, subject: string) =>
      h.state.transaction(() => h.suite.mail.send(from, { to: "samwise@cumuluscloud.app", subject, body: "x" }));
    await Promise.all([send(one, alex.cid, "From Alexis"), send(two, lee.cid, "From Leeroy")]);
    onRead = async () => {};
    assert.ok(arrived >= 3, "both read the same mailbox, and the loser read it again on its re-run");
    const subjects = (await one.state.transaction(() => one.suite.mail.view(sam.cid))).messages.map((m) => m.subject).filter((s) => s.startsWith("From ")).sort();
    assert.deepEqual(subjects, ["From Alexis", "From Leeroy"], "neither delivery overwrote the other");
  });

  it("two servers changing one mailbox's settings at once: neither change is lost", async () => {
    const one = host(base);
    const two = host(base);
    const pat = await one.state.transaction(() => one.suite.cid.createAccount({ username: "patricia" }));
    let arrived = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((r) => (release = r));
    onRead = async (ops) => {
      if (!(ops as { op: string; cid?: string }[]).some((o) => o.op === "mailbox" && o.cid === pat.cid)) return;
      if (++arrived === 2) release();
      if (arrived <= 2) await Promise.race([bothRead, new Promise((r) => setTimeout(r, 2000))]);
    };
    const save = (h: ReturnType<typeof host>, name: string) =>
      h.state.transaction(() => h.suite.mail.addContact(pat.cid, { name, email: `${name.toLowerCase()}@example.com` }));
    await Promise.all([save(one, "Ada"), save(two, "Grace")]);
    onRead = async () => {};
    assert.ok(arrived >= 3, "both read the same mailbox, and the loser read it again on its re-run");
    const contacts = (await one.state.transaction(() => one.suite.mail.view(pat.cid))).contacts.map((c) => c.name).sort();
    assert.deepEqual(contacts, ["Ada", "Grace"]);
  });

  it("the account menu's unread count and mailbox check don't fetch the mailbox", async () => {
    const h = host(base);
    const [nia, oz] = await h.state.transaction(async () => [
      await h.suite.cid.createAccount({ username: "nia" }),
      await h.suite.cid.createAccount({ username: "ozzie" }),
    ]);
    await h.state.transaction(() => h.suite.mail.send(oz.cid, { to: "nia@cumuluscloud.app", subject: "Hi Nia", body: "x" }));
    const seen: unknown[] = [];
    onRead = async (ops) => { seen.push(...ops); };
    const [has, unread] = await h.state.transaction(async () => [await h.suite.mail.has(nia.cid), await h.suite.mail.unreadCount(nia.cid)]);
    onRead = async () => {};
    assert.equal(has, true);
    assert.ok(!seen.some((o: any) => o.op === "mailbox" && !o.only), `the whole mailbox was fetched: ${JSON.stringify(seen)}`);
    const view = await h.state.transaction(() => h.suite.mail.view(nia.cid));
    assert.equal(unread, view.unread);
    assert.ok(unread >= 1);
    assert.equal(await h.state.transaction(() => h.suite.mail.has("cid_nobody")), false);
  });

  it("two people mailing each other at the same moment: both messages go through (no deadlock)", async () => {
    const one = host(base);
    const two = host(base);
    const [ana, ben] = await one.state.transaction(async () => [
      await one.suite.cid.createAccount({ username: "anabel" }),
      await one.suite.cid.createAccount({ username: "benedikt" }),
    ]);
    for (let round = 0; round < 3; round++) {
      // Both read both mailboxes before either commits, so their writes really overlap.
      let arrived = 0;
      let release!: () => void;
      const bothRead = new Promise<void>((r) => (release = r));
      onRead = async (ops) => {
        if (!(ops as { op: string; cid?: string }[]).some((o) => o.op === "mailbox" && !("only" in o) && (o.cid === ana.cid || o.cid === ben.cid))) return;
        if (++arrived === 4) release();
        if (arrived <= 4) await Promise.race([bothRead, new Promise((r) => setTimeout(r, 2000))]);
      };
      const results = await Promise.allSettled([
        one.state.transaction(() => one.suite.mail.send(ana.cid, { to: "benedikt@cumuluscloud.app", subject: `Round ${round} from Ana`, body: "x" })),
        two.state.transaction(() => two.suite.mail.send(ben.cid, { to: "anabel@cumuluscloud.app", subject: `Round ${round} from Ben`, body: "x" })),
      ]);
      onRead = async () => {};
      assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled"], JSON.stringify(results.map((r) => r.status === "rejected" ? String(r.reason) : "ok")));
    }
    const inbox = async (cid: string) => (await one.state.transaction(() => one.suite.mail.view(cid))).messages.filter((m) => m.folder === "inbox" && m.subject.startsWith("Round")).length;
    assert.equal(await inbox(ana.cid), 3);
    assert.equal(await inbox(ben.cid), 3);
  });

  it("scheduled send through the gateway fetches only mailboxes with a draft that is due", async () => {
    const h = host(base);
    const [sky, tom] = await h.state.transaction(async () => [
      await h.suite.cid.createAccount({ username: "skyler" }),
      await h.suite.cid.createAccount({ username: "tomasz" }),
    ]);
    const when = new Date(Date.now() + 1000).toISOString();
    await h.state.transaction(() => h.suite.mail.schedule(sky.cid, { to: "tomasz@cumuluscloud.app", subject: "Soon", body: "x" }, when));
    await new Promise((r) => setTimeout(r, 1200));
    const fetched: string[] = [];
    onRead = async (ops) => { for (const o of ops as { op: string; cid?: string; only?: string }[]) if (o.op === "mailbox" && !o.only) fetched.push(o.cid!); };
    const sent = await h.state.transaction(() => h.suite.mail.sendAllDue());
    onRead = async () => {};
    assert.ok(sent >= 1);
    assert.ok(fetched.includes(sky.cid));
    assert.ok(!fetched.some((cid) => cid !== sky.cid && cid !== tom.cid), `only the due sender and the recipient were fetched: ${fetched.length}`);
    assert.equal((await h.state.transaction(() => h.suite.mail.view(tom.cid))).messages.filter((m) => m.subject === "Soon").length, 1);
  });

  it("copies an existing cumulus-mail document into the rows with nothing lost", async () => {
    const signer2 = generateSigner();
    const ledger = new Ledger(undefined, { authorizedSigners: [signer2.publicKey] });
    const before = createCumulus({ ledger, signer: signer2, rpId: "localhost", origins: [base] });
    const kit = await before.cid.createAccount({ username: "kit" });
    const jo = await before.cid.createAccount({ username: "joanne" });
    await before.mail.send(kit.cid, { to: "joanne@cumuluscloud.app, out@example.com", subject: "Hello Joanne", body: "first" });
    await before.mail.send(jo.cid, { to: "kit@cumuluscloud.app", subject: "Re: Hello Joanne", body: "second" });
    await pool.query("INSERT INTO public.nexus_docs (id, version, data) VALUES ('cumulus-mail', 1, $1) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data", [JSON.stringify(toSnapshot(before.stores.mail))]);
    const counts = (await pool.query("SELECT cumulus_rows.refresh_mail_from_document() AS r")).rows[0].r;
    assert.equal(counts.mailboxes, 2);
    assert.equal(counts.outbound, 1);
    const h = host(base);
    for (const who of [kit, jo]) {
      const want = (await before.mail.view(who.cid)).messages;
      const got = (await h.state.transaction(() => h.suite.mail.view(who.cid))).messages;
      assert.deepEqual(got.map((m) => [m.id, m.subject, m.folder]), want.map((m) => [m.id, m.subject, m.folder]), "same messages, same order");
    }
    assert.equal(await h.state.transaction(() => h.suite.mail.resolve("joanne@cumuluscloud.app")), jo.cid);
  });
});
