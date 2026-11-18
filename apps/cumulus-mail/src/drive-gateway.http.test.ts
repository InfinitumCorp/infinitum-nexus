/**
 * CUMULUS_ROWS=drive with CUMULUS_STORE=gateway: Drive metadata in cumulus_rows.drive_items through the
 * SQL the nexus-store edge function calls (public.cid_read, public.nexus_commit_cid), on a fresh database
 * with the Supabase migrations applied. The first request claims the cumulus-workspace document; two
 * servers saving the same document at once keep one save and tell the other it changed. Skipped unless
 * CID_TEST_PG_URL is set.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Entry } from "@infinitum/firmament";
import { applySnapshot, toSnapshot } from "@infinitum/cumulus";
import { QuotaStore, StorageQuota } from "@infinitum/cloud";
import { ConflictError, RemoteState, type DocRow, type NexusGateway } from "../../spectre/src/server/remote.ts";
import { cidStorageFromEnv, suiteDocuments } from "../../spectre/src/server/cid-store.ts";
import { emptyCumulusStores } from "@infinitum/cumulus";
import { DriveError, Workspace, WorkspaceStore } from "./workspace.ts";
import { attachDriveRows } from "./workspace-remote.ts";
import type { FileStore } from "./files.ts";

const url = process.env.CID_TEST_PG_URL;
const root = join(import.meta.dirname, "../../..");
const MIGRATIONS = [
  "20261104_nexus_store.sql", "20261113_cumulus_id_rows.sql", "20261114_cumulus_id_reverse.sql", "20261115_cumulus_rows_wallet_quota.sql",
  "20261116_cumulus_rows_mail.sql", "20261117_cumulus_rows_mail_counts.sql", "20261118_cumulus_rows_lock_order.sql", "20261119_cumulus_rows_mail_due.sql",
  "20261120_cumulus_rows_compare.sql", "20261121_cumulus_rows_claim.sql", "20261122_cumulus_rows_drive.sql",
  "20261123_cumulus_rows_drive_checks.sql",
];

const files = (): FileStore => {
  const blobs = new Map<string, Uint8Array>();
  return {
    put: async (k, d) => void blobs.set(k, d),
    get: async (k) => (blobs.has(k) ? { data: blobs.get(k)!, type: "application/json" } : null),
    delete: async (k) => void blobs.delete(k),
  };
};
const resolve = (who: string) => (who.startsWith("cid:") ? who : `cid:${who}`);

describe("Drive rows through the gateway", { skip: url ? false : "set CID_TEST_PG_URL to run" }, async () => {
  const { default: pg } = await import("pg");
  const dbName = `drive_gateway_${process.pid}`;
  let admin: InstanceType<typeof pg.Pool>;
  let pool: InstanceType<typeof pg.Pool>;

  const gateway = (hooks: { afterRead?: (ops: unknown[]) => Promise<void> } = {}): NexusGateway => ({
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
      const r = (await pool.query("SELECT public.cid_read($1::jsonb) AS r", [JSON.stringify(ops)])).rows[0].r as unknown[];
      await hooks.afterRead?.(ops);
      return r;
    },
  });

  /** A Mail host on CUMULUS_STORE=gateway with CUMULUS_ROWS=drive, wired as vercel.ts wires it. */
  const host = (hooks?: Parameters<typeof gateway>[0]) => {
    const g = gateway(hooks);
    const storage = cidStorageFromEnv({ CUMULUS_STORE: "gateway", CUMULUS_ROWS: "drive" }, g);
    const state = new RemoteState(g, suiteDocuments(storage, emptyCumulusStores()));
    state.metricsLog = null;
    state.participants.push(storage.participant!);
    state.rows = storage.rows!;
    const repository = attachDriveRows(state, (ops) => storage.readRows!(ops));
    const ws = new Workspace({ repository, quota: new StorageQuota({ store: new QuotaStore() }), files: blobs, resolve, label: (c) => c });
    return { state, ws, run: <T>(fn: () => Promise<T>) => state.transaction(fn) };
  };
  const blobs = files();

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
    for (const f of MIGRATIONS) await pool.query(readFileSync(join(root, "supabase/migrations", f), "utf8"));
  });
  after(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`).catch(() => admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`));
    await admin?.end();
  });

  let roadmap: string;

  it("refuses to serve Drive on rows until the Drive migration is applied", async () => {
    await pool.query("ALTER TABLE cumulus_rows.claims DROP CONSTRAINT claims_product_check");
    await pool.query("ALTER TABLE cumulus_rows.claims ADD CONSTRAINT claims_product_check CHECK (product IN ('cid', 'mail', 'wallet', 'quota'))");
    const { run } = host();
    await assert.rejects(run(async () => "served"), /couldn't be claimed .*20261122_cumulus_rows_drive/);
    for (const f of MIGRATIONS.slice(-2)) await pool.query(readFileSync(join(root, "supabase/migrations", f), "utf8")); // applying them again is fine
  });

  it("the first request sees what the cumulus-workspace document held", async () => {
    // Yesterday, on the document: Ada made a folder and a doc in it, and shared the folder with Bob.
    const doc = new WorkspaceStore();
    const yesterday = new Workspace({ store: doc, quota: new StorageQuota({ store: new QuotaStore() }), files: blobs, resolve, label: (c) => c });
    await yesterday.firstVisit("cid:ada");
    const folder = await yesterday.createFolder("cid:ada", "Plans");
    roadmap = (await yesterday.createDoc("cid:ada", "dox", "Roadmap", folder.id)).id;
    await yesterday.share("cid:ada", folder.id, "bob");
    await pool.query("INSERT INTO public.nexus_docs (id, version, data) VALUES ('cumulus-workspace', 3, $1)", [JSON.stringify(toSnapshot(doc))]);

    const { ws, run } = host();
    assert.equal(await run(() => ws.firstVisit("cid:ada")), false, "who opened Drive came across");
    assert.deepEqual((await run(() => ws.list("cid:bob", { q: "road" }))).items.map((i) => i.id), [roadmap]);
    const claim = (await pool.query("SELECT copied FROM cumulus_rows.claims WHERE product = 'drive'")).rows[0];
    assert.deepEqual(claim.copied, { items: 2, enabled: 1 });
    const compared = (await pool.query("SELECT cumulus_rows.compare_drive_with_document() AS c")).rows[0].c;
    assert.deepEqual(compared, { same: true, counts: { items: { document: 2, rows: 2 }, enabled: { document: 1, rows: 1 } } });
  });

  it("changes are rows, and a list sees this request's own changes", async () => {
    const { ws, run } = host();
    const listed = await run(async () => {
      const notes = await ws.createDoc("cid:bob", "dox", "Notes");
      await ws.update("cid:ada", roadmap, { name: "Roadmap 2027" });
      return (await ws.list("cid:bob", { q: "2027" })).items.map((i) => i.name).concat((await ws.list("cid:bob")).items.map((i) => i.name)).concat(notes.name);
    });
    assert.deepEqual(listed, ["Roadmap 2027", "Notes", "Notes"], "the rename and the new document, before the commit");
    const { rows } = await pool.query("SELECT data->>'name' AS name FROM cumulus_rows.drive_items ORDER BY 1");
    assert.deepEqual(rows.map((r) => r.name), ["Notes", "Plans", "Roadmap 2027"]);
    const compared = (await pool.query("SELECT cumulus_rows.compare_drive_with_document() AS c")).rows[0].c;
    const notesId = (await pool.query("SELECT id FROM cumulus_rows.drive_items WHERE data->>'name' = 'Notes'")).rows[0].id;
    assert.deepEqual(compared.differences, { items: { onlyInDocument: [], onlyInRows: [notesId], changed: [roadmap] } }, "the rows moved on from the document");
    // Another server, fresh: sees the same.
    const two = host();
    assert.equal((await two.run(() => two.ws.get("cid:ada", roadmap))).name, "Roadmap 2027");
  });

  it("two servers save the same document at once: one is kept, the other is told it changed", async () => {
    // Each server waits after reading the document's row until the other has read it too, so both
    // start from version 1 (as two people with the same document open would).
    const setup = host();
    const { id } = await setup.run(() => setup.ws.createDoc("cid:ada", "dox", "Shared"));
    await setup.run(() => setup.ws.share("cid:ada", id, "bob"));
    let arrived = 0;
    let release!: () => void;
    const both = new Promise<void>((r) => (release = r));
    const afterRead = async (ops: unknown[]) => {
      if (!(ops as { op: string; id?: string }[]).some((o) => o.op === "driveItem" && o.id === id)) return;
      if (++arrived === 2) release();
      await Promise.race([both, new Promise((r) => setTimeout(r, 1000))]);
    };
    const save = async (cid: string, html: string) => {
      const h = host({ afterRead });
      try {
        await h.run(() => h.ws.saveDoc(cid, id, { html }, 1));
        return "saved";
      } catch (err) {
        return err instanceof DriveError ? err.code : String(err);
      }
    };
    const outcomes = (await Promise.all([save("cid:ada", "<p>a</p>"), save("cid:bob", "<p>b</p>")])).sort();
    assert.deepEqual(outcomes, ["conflict", "saved"]);
    assert.equal((await setup.run(() => setup.ws.get("cid:ada", id))).version, 2, "saved once");
  });

  it("deleting for good removes the rows", async () => {
    const { ws, run } = host();
    const folder = (await run(() => ws.list("cid:ada"))).items.find((i) => i.name === "Plans")!;
    await run(() => ws.update("cid:ada", folder.id, { trashed: true }));
    assert.equal((await run(() => ws.emptyTrash("cid:ada"))).removed, 2);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM cumulus_rows.drive_items WHERE id = $1", [roadmap]);
    assert.equal(rows[0].n, 0);
  });
  it("rollback: the rows go back into the document, with what changed since", async () => {
    const before = (await pool.query("SELECT version FROM public.nexus_docs WHERE id = 'cumulus-workspace'")).rows[0].version;
    const r = (await pool.query("SELECT cumulus_rows.restore_drive_document() AS r")).rows[0].r;
    assert.equal(r.version, Number(before) + 1);
    assert.equal((await pool.query("SELECT cumulus_rows.compare_drive_with_document() AS c")).rows[0].c.same, true);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM cumulus_rows.claims WHERE product = 'drive'")).rows[0].n, 0, "a later switch copies again");

    // A host back on the document sees the rows' state: Shared (version 2) and Notes; Plans was deleted.
    const { data } = (await pool.query("SELECT data FROM public.nexus_docs WHERE id = 'cumulus-workspace'")).rows[0];
    const store = applySnapshot(new WorkspaceStore(), data);
    const back = new Workspace({ store, quota: new StorageQuota({ store: new QuotaStore() }), files: blobs, resolve, label: (c) => c });
    assert.deepEqual((await back.list("cid:ada")).items.map((i) => i.name), ["Shared"]);
    assert.deepEqual((await back.list("cid:bob")).items.map((i) => i.name), ["Notes"]);
    assert.equal(await back.firstVisit("cid:ada"), false);
  });
});
