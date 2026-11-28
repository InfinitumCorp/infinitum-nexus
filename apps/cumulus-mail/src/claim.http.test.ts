/**
 * Switching a host to rows without a manual refresh: with CUMULUS_STORE=gateway, a host's first request
 * claims the rows, so whatever the documents hold at that moment (accounts that signed up yesterday,
 * their mail) is in the rows before anything reads them, and a later start never replaces rows written
 * since. Runs the SQL the nexus-store edge function calls, on a fresh database with the Supabase
 * migrations applied. Skipped unless CID_TEST_PG_URL is set.
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
const MIGRATIONS = [
  "20261104_nexus_store.sql", "20261113_cumulus_id_rows.sql", "20261114_cumulus_id_reverse.sql", "20261115_cumulus_rows_wallet_quota.sql",
  "20261116_cumulus_rows_mail.sql", "20261117_cumulus_rows_mail_counts.sql", "20261118_cumulus_rows_lock_order.sql", "20261119_cumulus_rows_mail_due.sql",
  "20261120_cumulus_rows_compare.sql", "20261121_cumulus_rows_claim.sql", "20261122_cumulus_rows_drive.sql", "20261123_cumulus_rows_drive_checks.sql",
  "20261124_cumulus_rows_claim_safety.sql",
];
const CLAIM = MIGRATIONS.indexOf("20261121_cumulus_rows_claim.sql");

describe("rows claim their documents on a host's first request", { skip: url ? false : "set CID_TEST_PG_URL to run" }, async () => {
  const { default: pg } = await import("pg");
  const dbName = `rows_claim_${process.pid}`;
  let admin: InstanceType<typeof pg.Pool>;
  let pool: InstanceType<typeof pg.Pool>;
  let signer: Signer;

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
        throw new Error(`commit failed: ${(err as Error).message}`);
      }
    },
    async readRows(ops) {
      return (await pool.query("SELECT public.cid_read($1::jsonb) AS r", [JSON.stringify(ops)])).rows[0].r as unknown[];
    },
  });

  const host = () => {
    const g = gateway();
    const stores = emptyCumulusStores();
    const storage = cidStorageFromEnv({ CUMULUS_STORE: "gateway", CUMULUS_ROWS: "mail,wallet,quota" }, g);
    const state = new RemoteState(g, suiteDocuments(storage, stores));
    state.metricsLog = null;
    state.participants.push(storage.participant!);
    state.rows = storage.rows!;
    const ledger = new Ledger(state.ledgerStore, { authorizedSigners: [signer.publicKey] });
    const suite = createCumulus({ ledger, signer, rpId: "localhost", origins: ["http://localhost"], stores, repository: storage.repository, repositories: storage.repositories });
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
    pool = new pg.Pool({ connectionString: u.toString(), max: 6 });
    pool.on("error", () => {});
    signer = generateSigner();
  });
  after(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`).catch(() => admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`));
    await admin?.end();
  });

  it("refuses to serve until the claim migration is applied", async () => {
    for (const f of MIGRATIONS.slice(0, CLAIM)) await pool.query(readFileSync(join(root, "supabase/migrations", f), "utf8"));
    const h = host();
    await assert.rejects(h.state.transaction(async () => "served"), /couldn't be claimed .*20261124_cumulus_rows_claim_safety/);
    for (const f of MIGRATIONS.slice(CLAIM)) await pool.query(readFileSync(join(root, "supabase/migrations", f), "utf8"));
  });

  it("the first request sees what the documents held; later starts keep what the rows got since", async () => {
    // Yesterday, in document mode: Ada signed up, got mail and some money.
    const yesterday = createCumulus({ ledger: new Ledger(undefined, { authorizedSigners: [signer.publicKey] }), signer, rpId: "localhost", origins: ["http://localhost"] });
    const ada = await yesterday.cid.createAccount({ username: "ada" });
    await yesterday.credit(ada.cid, "USDC", "4", "Deposit");
    await yesterday.mail.send(ada.cid, { to: "ada@cumuluscloud.app", subject: "Note to self", body: "x" });
    const docs: [string, object][] = [["cid", yesterday.stores.cid], ["cumulus-mail", yesterday.stores.mail], ["firm-wallet", yesterday.stores.wallet], ["cumulus-quota", yesterday.stores.quota]];
    for (const [id, store] of docs) await pool.query("INSERT INTO public.nexus_docs (id, version, data) VALUES ($1, 7, $2)", [id, JSON.stringify(toSnapshot(store))]);

    // Today the host starts on rows. No refresh was run by hand.
    const one = host();
    const seen = await one.state.transaction(async () => ({
      username: (await one.suite.cid.getAccount(ada.cid)).username,
      usdc: (await one.suite.wallets.balances(ada.cid)).USDC,
      mail: (await one.suite.mail.view(ada.cid)).messages.filter((m) => m.subject === "Note to self").length,
    }));
    assert.deepEqual(seen, { username: "ada", usdc: "4", mail: 2 });
    const claims = (await pool.query("SELECT product, document_version FROM cumulus_rows.claims ORDER BY product")).rows;
    assert.deepEqual(claims.map((c) => c.product), ["cid", "mail", "quota", "wallet"]);

    // A sign-up on rows, then another server starts (and claims again): the new account stays.
    const bob = await one.state.transaction(() => one.suite.cid.createAccount({ username: "bobby" }));
    const two = host();
    assert.equal(await two.state.transaction(async () => (await two.suite.cid.getAccount(bob.cid)).username), "bobby");
    assert.equal(await two.state.transaction(async () => (await two.suite.cid.getAccount(ada.cid)).username), "ada");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM cumulus_rows.claims")).rows[0].n, 4, "claimed once each");
  });
});
