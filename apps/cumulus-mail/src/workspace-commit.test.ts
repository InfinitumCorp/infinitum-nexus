/**
 * Stored files are deleted only once the request's changes are saved (WorkspaceDeps.afterCommit): a
 * permanent delete, or the save that makes old contents unreachable, that is rolled back or re-run keeps
 * the files its saved items still point to.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { QuotaStore, StorageQuota } from "@infinitum/cloud";
import { Workspace, WorkspaceStore } from "./workspace.ts";
import { MemoryFileStore } from "./files.ts";

const setup = () => {
  const files = new MemoryFileStore();
  const pending: (() => Promise<void>)[] = [];
  const ws = new Workspace({
    store: new WorkspaceStore(), quota: new StorageQuota({ store: new QuotaStore() }), files,
    resolve: (w) => (w.startsWith("cid:") ? w : `cid:${w}`), label: (c) => c,
    afterCommit: (fn) => void pending.push(fn),
  });
  const commit = async () => { for (const fn of pending.splice(0)) await fn(); };
  return { ws, files, pending, commit };
};

describe("Drive deletes stored files after the change is saved", () => {
  test("deleting for good: the contents stay until the deletion is saved", async () => {
    const { ws, files, pending, commit } = setup();
    const f = await ws.upload("cid:a", "a.bin", null, new Uint8Array([1, 2, 3]), "application/octet-stream");
    await ws.update("cid:a", f.id, { trashed: true });
    assert.equal(files.files.size, 1);
    assert.deepEqual(await ws.remove("cid:a", f.id), { removed: 1 });
    assert.equal(files.files.size, 1, "not yet: the request isn't saved");
    assert.equal(pending.length, 1);
    await commit();
    assert.equal(files.files.size, 0);
  });

  test("saving a document: the contents before the last save go, once the save is kept", async () => {
    const { ws, files, commit } = setup();
    const doc = await ws.createDoc("cid:a", "dox", "Notes");
    await ws.saveDoc("cid:a", doc.id, { html: "<p>1</p>" }, 1);
    await ws.saveDoc("cid:a", doc.id, { html: "<p>2</p>" }, 2);
    assert.equal(files.files.size, 3, "original, first and second save");
    await commit();
    assert.equal(files.files.size, 2, "the original is gone; the first save stays for readers that started before the second");
    assert.deepEqual((await ws.readDoc("cid:a", doc.id)).doc, { html: "<p>2</p>" });
  });
});
