import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { StorageQuota, QuotaError, QuotaStore, GB, MapQuotaRepository, CopyingQuotaRepository, type QuotaRepository } from "./quota.ts";
import { CloudStore } from "./store.ts";

// The same behavior on the in-memory store and on a repository that copies values in and out (as a
// database does), so nothing depends on mutating a usage row that was read.
for (const [name, repository] of [
  ["in-memory store", (s: QuotaStore): QuotaRepository => new MapQuotaRepository(s)],
  ["copying repository", (s: QuotaStore): QuotaRepository => new CopyingQuotaRepository(s)],
] as const) {
  describe(`storage quota on the ${name}`, () => {
    const make = (freeGb?: number) => {
      const store = new QuotaStore();
      return new StorageQuota({ store, repository: repository(store), ...(freeGb ? { freeGb } : {}) });
    };

    test("mail and cloud share one 15 GB free quota", async () => {
      const quota = make();
      await quota.charge("cid:a", "mail", 5 * GB);
      await quota.charge("cid:a", "cloud", 9 * GB);
      const usage = await quota.usage("cid:a");
      assert.equal(usage.usedBytes, 14 * GB);
      assert.equal(usage.limitBytes, 15 * GB);
      await assert.rejects(quota.charge("cid:a", "cloud", 2 * GB), QuotaError);
      assert.equal((await quota.usage("cid:a")).usedBytes, 14 * GB, "a refused charge changes nothing");
      await quota.setExtraGb("cid:a", 100);
      assert.equal(await quota.canFit("cid:a", 2 * GB), true, "paid storage adds room");
      await quota.setExtraGb("cid:a", 0);
      assert.equal((await quota.usage("cid:a")).limitBytes, 15 * GB);
    });

    test("cloud files count against the quota and are released on delete", async () => {
      const quota = make(1);
      const shares: string[] = [];
      const cloud = new CloudStore({ quota, notifier: { shared: ({ recipient }) => { shares.push(recipient); } } });
      await cloud.put("a.bin", "cid:a", 0.6 * GB);
      await assert.rejects(cloud.put("b.bin", "cid:a", 0.6 * GB), QuotaError);
      await cloud.put("a.bin", "cid:a", 0.2 * GB); // shrinking an existing file frees space
      assert.equal((await quota.usage("cid:a")).byProduct.cloud, 0.2 * GB);
      await cloud.share("a.bin", "cid:a", "cid:b");
      assert.deepEqual(shares, ["cid:b"]);
      assert.equal(await cloud.remove("a.bin", "cid:b"), false, "only the owner can delete");
      assert.equal(await cloud.remove("a.bin", "cid:a"), true);
      assert.equal((await quota.usage("cid:a")).usedBytes, 0);
    });

    test("a negative size cannot shrink the quota", async () => {
      const quota = make(1);
      const cloud = new CloudStore({ quota });
      await cloud.put("real.bin", "cid:a", 0.4 * GB);
      await assert.rejects(cloud.put("fake.bin", "cid:a", -GB), RangeError);
      await assert.rejects(cloud.put("real.bin", "cid:a", -1), RangeError);
      assert.equal(cloud.get("fake.bin"), undefined);
      assert.equal(cloud.get("real.bin")?.size, 0.4 * GB);
      assert.equal((await quota.usage("cid:a")).usedBytes, 0.4 * GB);
    });
  });
}
