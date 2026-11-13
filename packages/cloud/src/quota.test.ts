import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { StorageQuota, QuotaError, QuotaStore, GB, MapQuotaRepository, CopyingQuotaRepository, type QuotaRepository } from "./quota.ts";
import { CloudStore } from "./store.ts";
import { PgQuotaRepository, migrateQuota } from "./quota-postgres.ts";

// CID_TEST_PG_URL (the PostgreSQL CI job sets it) adds a run on PgQuotaRepository, a fresh schema each time.
const pgUrl = process.env.CID_TEST_PG_URL;
const pgPool = pgUrl ? new (await import("pg")).default.Pool({ connectionString: pgUrl, max: 6 }) : null;
const pgSchemas: string[] = [];
after(async () => {
  for (const s of pgSchemas) await pgPool!.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
  await pgPool?.end();
});
async function pgRepository(): Promise<QuotaRepository> {
  const schema = `quota_test_${process.pid}_${pgSchemas.length}`;
  pgSchemas.push(schema);
  await migrateQuota(pgPool!, schema);
  return new PgQuotaRepository({ db: pgPool!, schema });
}

// The same behavior on the in-memory store and on a repository that copies values in and out (as a
// database does), so nothing depends on mutating a usage row that was read.
const variants: [string, (s: QuotaStore) => Promise<QuotaRepository>][] = [
  ["in-memory store", async (s) => new MapQuotaRepository(s)],
  ["copying repository", async (s) => new CopyingQuotaRepository(s)],
];
if (pgPool) variants.push(["PostgreSQL", () => pgRepository()]);
for (const [name, repository] of variants) {
  describe(`storage quota on the ${name}`, () => {
    const make = async (freeGb?: number) => {
      const store = new QuotaStore();
      return new StorageQuota({ store, repository: await repository(store), ...(freeGb ? { freeGb } : {}) });
    };

    test("mail and cloud share one 15 GB free quota", async () => {
      const quota = await make();
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
      const quota = await make(1);
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
      const quota = await make(1);
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

describe("storage quota on PostgreSQL, two uploads at once", { skip: pgPool ? false : "set CID_TEST_PG_URL to run" }, () => {
  test("two transactions filling the last free space: the second waits for the first and is refused", async () => {
    const schema = `quota_race_${process.pid}`;
    pgSchemas.push(schema);
    await migrateQuota(pgPool!, schema);
    // Each upload waits after reading the usage row until the other has read it too (or 500 ms pass,
    // which is what happens when the row lock makes the second one wait), so the reads overlap.
    let arrived = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((r) => (release = r));
    await new StorageQuota({ repository: new PgQuotaRepository({ db: pgPool!, schema }), freeGb: 1 }).charge("cid:a", "cloud", 1);
    const upload = async () => {
      const client = await pgPool!.connect();
      const db = {
        async query(text: string, params?: unknown[]) {
          const r = await client.query(text, params);
          if (/SELECT mail_bytes, cloud_bytes/.test(text)) {
            if (++arrived === 2) release();
            await Promise.race([bothRead, new Promise((r) => setTimeout(r, 500))]);
          }
          return r;
        },
      };
      try {
        await client.query("BEGIN");
        await new StorageQuota({ repository: new PgQuotaRepository({ db, schema }), freeGb: 1 }).charge("cid:a", "cloud", 0.6 * GB);
        await client.query("COMMIT");
        return "stored";
      } catch (err) {
        await client.query("ROLLBACK");
        return err instanceof QuotaError ? "full" : String(err);
      } finally {
        client.release();
      }
    };
    assert.deepEqual((await Promise.all([upload(), upload()])).sort(), ["full", "stored"]);
    const after = await new StorageQuota({ repository: new PgQuotaRepository({ db: pgPool!, schema }), freeGb: 1 }).usage("cid:a");
    assert.equal(after.usedBytes, 0.6 * GB + 1, "never over the plan");
  });
});

