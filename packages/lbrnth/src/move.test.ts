import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { PostgresStorage } from "./postgres.ts";
import type { SqlDatabase } from "./postgres.ts";
import type { Organization } from "./model.ts";
import { hostKeyForOrg, moveOrganizations } from "./move.ts";

const MIGRATION = readFileSync(new URL("../../../supabase/migrations/20261111_lbrnth_store.sql", import.meta.url), "utf8");

async function database(): Promise<{ pg: PGlite; db: SqlDatabase }> {
  const pg = new PGlite();
  await pg.exec("create role anon; create role authenticated;");
  await pg.exec(MIGRATION);
  const db: SqlDatabase = {
    query: (text, params) => pg.query(text, params) as never,
    transaction: fn => pg.transaction(tx => fn({ query: (text, params) => tx.query(text, params) as never })),
  };
  return { pg, db };
}

const RU = new Uint8Array(32).fill(7);
const US = new Uint8Array(32).fill(9);
const org = (id: string, name: string): Organization => ({ id, name, members: [{ cid: "cid_a", role: "owner" }], repositories: [], audit: [] });

async function seed(db: SqlDatabase, master: Uint8Array, orgs: Organization[]) {
  const s = new PostgresStorage(db, hostKeyForOrg(master));
  await s.refresh();
  s.save(orgs);
  await s.flush();
}

async function read(db: SqlDatabase, master: Uint8Array) {
  const s = new PostgresStorage(db, hostKeyForOrg(master));
  await s.refresh();
  return s.load();
}

test("dry run (the default) reports and writes nothing", async () => {
  const ru = await database(), us = await database();
  await seed(ru.db, RU, [org("org_a", "Alpha"), org("org_b", "Beta")]);
  const report = await moveOrganizations({ source: ru.db, sourceMasterKey: RU, target: us.db, targetMasterKey: US, orgIds: ["org_a", "org_x"] });
  assert.equal(report.dryRun, true);
  assert.deepEqual(report.copied, ["org_a"]);
  assert.deepEqual(report.missing, ["org_x"]);
  assert.equal((await us.pg.query("select 1 from lbrnth.org_snapshots")).rows.length, 0);
});

test("moved orgs open with the target key only, the source is untouched, existing target orgs are kept", async () => {
  const ru = await database(), us = await database();
  await seed(ru.db, RU, [org("org_a", "Alpha"), org("org_b", "Beta"), org("org_c", "Gamma")]);
  await seed(us.db, US, [org("org_c", "Gamma (newer US work)")]);
  await ru.pg.query("insert into lbrnth.entitlements (org_id, plan, active, source, note) values ('org_a', 'team', true, 'operator', 'paid')");
  const before = (await ru.pg.query("select org_id, revision, ciphertext from lbrnth.org_snapshots order by org_id")).rows;

  const report = await moveOrganizations({ source: ru.db, sourceMasterKey: RU, target: us.db, targetMasterKey: US, orgIds: "all", dryRun: false });
  assert.deepEqual(report.copied, ["org_a", "org_b"]);
  assert.deepEqual(report.skippedExisting, ["org_c"]);
  assert.deepEqual(report.entitlements, ["org_a"]);

  const moved = await read(us.db, US);
  assert.deepEqual(moved.map(o => [o.id, o.name]).sort(), [["org_a", "Alpha"], ["org_b", "Beta"], ["org_c", "Gamma (newer US work)"]]);
  // Re-encrypted: the Russia key cannot open the target's envelopes.
  await assert.rejects(read(us.db, RU), /authentication/);
  // Source unchanged byte for byte.
  assert.deepEqual((await ru.pg.query("select org_id, revision, ciphertext from lbrnth.org_snapshots order by org_id")).rows, before);
  // Entitlement came along.
  assert.deepEqual((await us.pg.query("select org_id, plan, active from lbrnth.entitlements")).rows, [{ org_id: "org_a", plan: "team", active: true }]);
  // Running it again is a no-op.
  const again = await moveOrganizations({ source: ru.db, sourceMasterKey: RU, target: us.db, targetMasterKey: US, orgIds: "all", dryRun: false });
  assert.deepEqual(again.copied, []);
  assert.deepEqual(again.skippedExisting.sort(), ["org_a", "org_b", "org_c"]);
});

test("a wrong source key fails before anything is written", async () => {
  const ru = await database(), us = await database();
  await seed(ru.db, RU, [org("org_a", "Alpha")]);
  await assert.rejects(moveOrganizations({ source: ru.db, sourceMasterKey: US, target: us.db, targetMasterKey: US, orgIds: "all", dryRun: false }), /authentication/);
  assert.equal((await us.pg.query("select 1 from lbrnth.org_snapshots")).rows.length, 0);
});

test("keys must be 32 bytes", () => {
  assert.throws(() => hostKeyForOrg(new Uint8Array(16)), /32 bytes/);
});
