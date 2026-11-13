/** Drive and the shared storage quota: a file that doesn't fit is refused and nothing is kept. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CopyingQuotaRepository, QuotaError, QuotaStore, StorageQuota } from "@infinitum/cloud";
import { Workspace, WorkspaceStore } from "./workspace.ts";
import type { FileStore } from "./files.ts";

test("an upload over the quota is refused with nothing stored; deleting gives the space back", async () => {
  const qs = new QuotaStore();
  // 1 MB plan on a repository that copies values in and out, as a database would.
  const quota = new StorageQuota({ store: qs, repository: new CopyingQuotaRepository(qs), freeGb: 0.001 });
  const blobs = new Map<string, Uint8Array>();
  const files: FileStore = {
    put: async (k, d) => void blobs.set(k, d),
    get: async (k) => (blobs.has(k) ? { data: blobs.get(k)!, type: "application/octet-stream" } : null),
    delete: async (k) => void blobs.delete(k),
  };
  const ws = new Workspace({ store: new WorkspaceStore(), quota, files, resolve: () => undefined, label: (c) => c });

  const ok = await ws.upload("cid:a", "small.bin", null, new Uint8Array(600_000), "application/octet-stream");
  assert.equal((await quota.usage("cid:a")).usedBytes, 600_000);
  await assert.rejects(ws.upload("cid:a", "big.bin", null, new Uint8Array(600_000), "application/octet-stream"), QuotaError);
  assert.equal((await quota.usage("cid:a")).usedBytes, 600_000, "the refused upload charged nothing");
  assert.equal(blobs.size, 1, "and stored nothing");
  assert.deepEqual((await ws.list("cid:a")).items.map((i) => i.name), ["small.bin"]);

  await ws.update("cid:a", ok.id, { trashed: true });
  await ws.remove("cid:a", ok.id);
  assert.equal((await quota.usage("cid:a")).usedBytes, 0);
  assert.equal(blobs.size, 0);
});
