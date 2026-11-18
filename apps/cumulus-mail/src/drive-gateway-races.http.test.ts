/**
 * Drive through the gateway when requests overlap (CUMULUS_ROWS=drive, CUMULUS_STORE=gateway, with
 * 20261123_cumulus_rows_drive_checks.sql): what a request decided on still holds when it is saved.
 * Two moves into each other, an upload into a folder being deleted, two saves of one document. Each
 * case was a lost or hidden item before. Skipped unless CID_TEST_PG_URL is set.
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
  "20261120_cumulus_rows_compare.sql", "20261121_cumulus_rows_claim.sql", "20261122_cumulus_rows_drive.sql", "20261123_cumulus_rows_drive_checks.sql",
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

describe("Drive through the gateway, requests overlapping", { skip: url ? false : "set CID_TEST_PG_URL to run" }, async () => {
  const { default: pg } = await import("pg");
  const dbName = `drive_races_${process.pid}`;
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
  const host = (hooks?: Parameters<typeof gateway>[0], fs: FileStore = blobs) => {
    const g = gateway(hooks);
    const storage = cidStorageFromEnv({ CUMULUS_STORE: "gateway", CUMULUS_ROWS: "drive" }, g);
    const state = new RemoteState(g, suiteDocuments(storage, emptyCumulusStores()));
    state.metricsLog = null;
    state.participants.push(storage.participant!);
    state.rows = storage.rows!;
    const repository = attachDriveRows(state, (ops) => storage.readRows!(ops));
    const ws = new Workspace({ repository, quota: new StorageQuota({ store: new QuotaStore() }), files: fs, resolve, label: (c) => c });
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


  /** Two requests that each wait after their reads until both have read (or 1s). */
  const barrier = (match: (ops: any[]) => boolean) => {
    let arrived = 0; let release!: () => void;
    const both = new Promise<void>((r) => (release = r));
    const seen = new Set<unknown>();
    return (tag: string) => async (ops: unknown[]) => {
      if (!match(ops as any[]) || seen.has(tag)) return;
      seen.add(tag);
      if (++arrived === 2) release();
      await Promise.race([both, new Promise((r) => setTimeout(r, 1000))]);
    };
  };

  it("two moves at once, A into B and B into A: one is refused, no folder ends up inside itself", async () => {
    const s = host();
    const a = await s.run(() => s.ws.createFolder("cid:ada", "A"));
    const b = await s.run(() => s.ws.createFolder("cid:ada", "B"));
    const doc = await s.run(() => s.ws.createDoc("cid:ada", "dox", "Inside A", a.id));
    const bar = barrier((ops) => ops.some((o) => o.op === "driveItem"));
    // wait after the cycle-check walk has read both folders: hook on the read of the *target's* parent
    let n1 = 0, n2 = 0;
    const h1 = host({ afterRead: async (ops) => { if (++n1 === 2) await bar("1")(ops); } });
    const h2 = host({ afterRead: async (ops) => { if (++n2 === 2) await bar("2")(ops); } });
    const r = await Promise.allSettled([
      h1.run(() => h1.ws.update("cid:ada", a.id, { parent: b.id })),
      h2.run(() => h2.ws.update("cid:ada", b.id, { parent: a.id })),
    ]);
    assert.deepEqual(r.map((x) => (x.status === "fulfilled" ? "ok" : String((x as any).reason?.code ?? (x as any).reason))).sort(), ["cycle", "ok"]);
    const rows = (await pool.query("SELECT id, data->>'name' AS name, data->>'parent' AS parent FROM cumulus_rows.drive_items WHERE id = ANY($1)", [[a.id, b.id]])).rows;
    assert.equal(rows.filter((x) => x.parent).length, 1, "only one of them moved");
    assert.equal((await s.run(() => s.ws.list("cid:ada"))).items.length, 1, "the other is still in My Drive, holding the first");
    void doc;
  });

  it("an upload into a folder while it is being deleted for good is deleted with it, not left behind", async () => {
    const s = host();
    const f = await s.run(() => s.ws.createFolder("cid:cy", "F"));
    const sub = await s.run(() => s.ws.createFolder("cid:cy", "S", f.id));
    await s.run(() => s.ws.update("cid:cy", f.id, { trashed: true }));
    let gate!: () => void; const go = new Promise<void>((r) => (gate = r));
    // The delete request pauses after it listed S's children, until the upload has committed.
    const h1 = host({ afterRead: async (ops) => { if ((ops as any[]).some((o) => o.op === "driveChildren" && o.parent === sub.id)) await go; } });
    const del = h1.run(() => h1.ws.remove("cid:cy", f.id));
    await new Promise((r) => setTimeout(r, 100));
    const h2 = host();
    const up = await h2.run(() => h2.ws.upload("cid:cy", "x.bin", sub.id, new Uint8Array(1000), "application/octet-stream"));
    gate();
    assert.deepEqual(await del, { removed: 3 }, "the deletion ran again and took the upload");
    const rows = (await pool.query("SELECT id, data->>'name' AS name, data->>'parent' AS parent FROM cumulus_rows.drive_items WHERE owner = 'cid:cy'")).rows;
    assert.deepEqual(rows, []);
    assert.deepEqual((await s.run(() => s.ws.list("cid:cy", { q: "x.bin" }))).items, []);
    void up;
  });

  it("two saves of one document at once: the contents kept are the ones of the save that was kept", async () => {
    const shared = files();
    const s = host(undefined, shared);
    const { id } = await s.run(() => s.ws.createDoc("cid:dee", "dox", "Doc"));
    await s.run(() => s.ws.share("cid:dee", id, "eve"));
    const bar = barrier((ops) => ops.some((o) => o.op === "driveItem" && o.id === id));
    let aCommitted!: () => void; const aDone = new Promise<void>((r) => (aCommitted = r));
    const slow: FileStore = { ...shared, put: async (k, d, t) => { await Promise.race([aDone, new Promise((r) => setTimeout(r, 2000))]); return shared.put(k, d, t); } };
    const hA = host({ afterRead: bar("A") }, shared);
    const hB = host({ afterRead: bar("B") }, slow);
    const pa = hA.run(() => hA.ws.saveDoc("cid:dee", id, { html: "<p>from dee</p>" }, 1)).then((v) => { aCommitted(); return "saved v" + v.version; });
    const pb = hB.run(() => hB.ws.saveDoc("cid:eve", id, { html: "<p>from eve</p>" }, 1)).then((v) => "saved v" + v.version, (e) => e instanceof DriveError ? e.code : String(e));
    assert.deepEqual([await pa, await pb], ["saved v2", "conflict"]);
    const after = await s.run(() => s.ws.readDoc("cid:dee", id));
    assert.deepEqual([after.item.version, after.item.updatedBy, after.doc], [2, "cid:dee", { html: "<p>from dee</p>" }]);
  });
});
