import { test } from "node:test";
import assert from "node:assert/strict";
import { StorageQuota, QuotaError, GB } from "./quota.ts";
import { CloudStore } from "./store.ts";

test("mail and cloud share one 15 GB free quota", () => {
  const quota = new StorageQuota();
  quota.charge("cid:a", "mail", 5 * GB);
  quota.charge("cid:a", "cloud", 9 * GB);
  const usage = quota.usage("cid:a");
  assert.equal(usage.usedBytes, 14 * GB);
  assert.equal(usage.limitBytes, 15 * GB);
  assert.throws(() => quota.charge("cid:a", "cloud", 2 * GB), QuotaError);
  assert.equal(quota.usage("cid:a").usedBytes, 14 * GB, "a refused charge changes nothing");
});

test("cloud files count against the quota and are released on delete", async () => {
  const quota = new StorageQuota({ freeGb: 1 });
  const shares: string[] = [];
  const cloud = new CloudStore({ quota, notifier: { shared: ({ recipient }) => { shares.push(recipient); } } });
  cloud.put("a.bin", "cid:a", 0.6 * GB);
  assert.throws(() => cloud.put("b.bin", "cid:a", 0.6 * GB), QuotaError);
  cloud.put("a.bin", "cid:a", 0.2 * GB); // shrinking an existing file frees space
  assert.equal(quota.usage("cid:a").byProduct.cloud, 0.2 * GB);
  await cloud.share("a.bin", "cid:a", "cid:b");
  assert.deepEqual(shares, ["cid:b"]);
  assert.equal(cloud.remove("a.bin", "cid:b"), false, "only the owner can delete");
  assert.equal(cloud.remove("a.bin", "cid:a"), true);
  assert.equal(quota.usage("cid:a").usedBytes, 0);
});

test("a negative size cannot shrink the quota", () => {
  const quota = new StorageQuota({ freeGb: 1 });
  const cloud = new CloudStore({ quota });
  cloud.put("real.bin", "cid:a", 0.4 * GB);
  assert.throws(() => cloud.put("fake.bin", "cid:a", -GB), RangeError);
  assert.throws(() => cloud.put("real.bin", "cid:a", -1), RangeError);
  assert.equal(cloud.get("fake.bin"), undefined);
  assert.equal(cloud.get("real.bin")?.size, 0.4 * GB);
  assert.equal(quota.usage("cid:a").usedBytes, 0.4 * GB);
});
