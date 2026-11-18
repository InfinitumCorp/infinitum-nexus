/**
 * Drive metadata on PostgreSQL (PgWorkspaceRepository). Runs when CID_TEST_PG_URL is set (the
 * PostgreSQL CI job sets it).
 */
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { QuotaStore, StorageQuota } from "@infinitum/cloud";
import { DriveError, Workspace, WorkspaceStore } from "./workspace.ts";
import { PgWorkspaceRepository, claimDriveRows, migrateDrive, type DriveQueryable, type DriveTransactional } from "./workspace-postgres.ts";
import type { FileStore } from "./files.ts";

const url = process.env.CID_TEST_PG_URL;
const { default: pg } = url ? await import("pg") : { default: undefined as never };
const pool = url ? new pg.Pool({ connectionString: url, max: 6, allowExitOnIdle: true }) : undefined;
pool?.on("error", () => {});
const schemas: string[] = [];
after(async () => {
  if (!pool) return;
  for (const s of schemas) await pool.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
  await pool.end();
});

const files = (): FileStore => {
  const blobs = new Map<string, Uint8Array>();
  return {
    put: async (k, d) => void blobs.set(k, d),
    get: async (k) => (blobs.has(k) ? { data: blobs.get(k)!, type: "application/json" } : null),
    delete: async (k) => void blobs.delete(k),
  };
};

async function fresh(name: string) {
  const schema = `drive_${name}_${process.pid}`;
  schemas.push(schema);
  await pool!.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await migrateDrive(pool!, schema);
  return schema;
}

const workspace = (db: DriveQueryable, schema: string, blobs: FileStore, quota = new StorageQuota({ store: new QuotaStore() })) =>
  new Workspace({ repository: new PgWorkspaceRepository({ db, schema }), quota, files: blobs, resolve: (who) => (who.startsWith("cid:") ? who : `cid:${who}`), label: (c) => c });

describe("Drive on PostgreSQL", { skip: url ? false : "set CID_TEST_PG_URL to run" }, () => {
  test("folders, documents, sharing, trash and search live in rows", async () => {
    const schema = await fresh("rows");
    const ws = workspace(pool!, schema, files());
    assert.equal(await ws.firstVisit("cid:a"), true);
    assert.equal(await ws.firstVisit("cid:a"), false);
    const folder = await ws.createFolder("cid:a", "Plans");
    const doc = await ws.createDoc("cid:a", "dox", "Roadmap", folder.id);
    await ws.createDoc("cid:a", "spreads", "Budget");
    assert.deepEqual((await ws.list("cid:a")).items.map((i) => i.name), ["Plans", "Budget"]);
    assert.deepEqual((await ws.list("cid:a", { folder: folder.id })).items.map((i) => i.name), ["Roadmap"]);

    // Sharing a folder shares what is inside it.
    await ws.share("cid:a", folder.id, "b");
    assert.deepEqual((await ws.list("cid:b", { view: "shared" })).items.map((i) => i.name), ["Plans"]);
    assert.deepEqual((await ws.list("cid:b", { q: "road" })).items.map((i) => i.name), ["Roadmap"]);
    const saved = await ws.saveDoc("cid:b", doc.id, { html: "<p>Q1</p>" }, 1);
    assert.equal(saved.version, 2);
    assert.deepEqual((await ws.readDoc("cid:a", doc.id)).doc, { html: "<p>Q1</p>" });

    // Trash and delete for good, contents included.
    await ws.update("cid:a", folder.id, { trashed: true });
    assert.deepEqual((await ws.list("cid:b", { q: "road" })).items, [], "a trashed folder hides what's inside from others");
    assert.deepEqual((await ws.list("cid:a", { view: "trash" })).items.map((i) => i.name), ["Plans"]);
    assert.equal((await ws.emptyTrash("cid:a")).removed, 2);
    const { rows } = await pool!.query(`SELECT count(*)::int AS n FROM "${schema}".drive_items`);
    assert.equal(rows[0].n, 1, "only Budget is left");
  });

  test("two saves of the same document at once: one is kept, the other is told it changed", async () => {
    const schema = await fresh("race");
    const blobs = files();
    const setup = workspace(pool!, schema, blobs);
    const doc = await setup.createDoc("cid:a", "dox", "Notes");
    await setup.share("cid:a", doc.id, "b");

    // Each save waits after reading the item until the other has read it too (or 500 ms pass, which is
    // what happens when the row lock makes the second one wait), so the reads overlap.
    let arrived = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((r) => (release = r));
    const save = async (cid: string, html: string) => {
      const client = await pool!.connect();
      const db: DriveQueryable = {
        async query(text, params) {
          const r = await client.query(text, params);
          if (/FROM "[^"]+"\.drive_items WHERE id = \$1/.test(text) && params?.[0] === doc.id) {
            if (++arrived === 2) release();
            await Promise.race([bothRead, new Promise((r) => setTimeout(r, 500))]);
          }
          return r;
        },
      };
      try {
        await client.query("BEGIN");
        await workspace(db, schema, blobs).saveDoc(cid, doc.id, { html }, 1);
        await client.query("COMMIT");
        return "saved";
      } catch (err) {
        await client.query("ROLLBACK");
        return err instanceof DriveError ? err.code : String(err);
      } finally {
        client.release();
      }
    };
    const outcomes = (await Promise.all([save("cid:a", "<p>from a</p>"), save("cid:b", "<p>from b</p>")])).sort();
    assert.deepEqual(outcomes, ["conflict", "saved"]);
    assert.equal((await setup.get("cid:a", doc.id)).version, 2, "saved once");
  });
  test("the first start copies the cumulus-workspace document into the rows, once ever", async () => {
    const schema = `drive_claim_${process.pid}`;
    schemas.push(schema);
    await pool!.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    // Yesterday, on the document: Ada made a folder and shared a doc in it with Bob.
    const doc = new WorkspaceStore();
    const yesterday = new Workspace({ store: doc, quota: new StorageQuota({ store: new QuotaStore() }), files: files(), resolve: (w) => (w.startsWith("cid:") ? w : `cid:${w}`), label: (c) => c });
    await yesterday.firstVisit("cid:ada");
    const folder = await yesterday.createFolder("cid:ada", "Plans");
    const roadmap = await yesterday.createDoc("cid:ada", "dox", "Roadmap", folder.id);
    await yesterday.share("cid:ada", folder.id, "bob");

    // Two servers start at once; each is a connection holding its own transaction.
    let loads = 0;
    const server = async () => {
      const client = await pool!.connect();
      const db: DriveTransactional = {
        query: (t, p) => client.query(t, p),
        begin: async () => void (await client.query("BEGIN")),
        commit: async () => void (await client.query("COMMIT")),
        rollback: async () => void (await client.query("ROLLBACK")),
      };
      try {
        return await claimDriveRows(db, schema, async () => (loads++, doc));
      } finally {
        client.release();
      }
    };
    const results = await Promise.all([server(), server()]);
    assert.equal(loads, 1, "the document is read by one server only");
    assert.deepEqual(results.map((r) => ("already" in r ? "already" : r.copied.items)).sort(), [2, "already"]);

    const today = workspace(pool!, schema, files());
    assert.equal(await today.firstVisit("cid:ada"), false, "who opened Drive came across");
    assert.deepEqual((await today.list("cid:bob", { q: "road" })).items.map((i) => i.id), [roadmap.id]);

    // A rename on rows, then a restart: the rename stays.
    await today.update("cid:ada", roadmap.id, { name: "Roadmap 2027" });
    assert.deepEqual(await server(), { already: true });
    assert.equal((await today.get("cid:ada", roadmap.id)).name, "Roadmap 2027");
  });
});
