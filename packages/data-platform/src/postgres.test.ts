// © Infinitum Corporation®. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PgOntologyMirror, PgPolicyRepository, optInKeyFor, type Queryable } from "./postgres.ts";
import { MemoryTenancy, PolicyService, Pseudonymizer } from "./policy.ts";
import { CidTenancy } from "./tenancy.ts";
import { MemoryObjectStore, PreconditionFailed } from "./storage.ts";
import { Lakehouse } from "./lakehouse.ts";
import type { Envelope } from "./envelope.ts";
import { CloudDriveAdapter } from "./adapters/cloud.ts";
import { ALICE, BOB, kit, TENANT } from "./testkit.test-util.ts";

/** Records every statement; serves the two list queries from in-memory tables. */
function fakeDb(fail?: string) {
  const log: { tag: string; params: unknown[] }[] = [];
  const policies: Record<string, unknown>[] = [];
  const optIns: { product: string; subject_id: string }[] = [];
  const db: Queryable = {
    async query(text, params = []) {
      const tag = /^-- (\S+)/.exec(text)?.[1] ?? text.trim();
      log.push({ tag, params });
      if (fail && tag === fail) throw new Error("db down");
      if (tag === "policy.list") return { rows: policies };
      if (tag === "optin.list") return { rows: optIns };
      if (tag === "optin.insert") optIns.push({ product: String(params[0]), subject_id: String(params[1]) });
      return { rows: [], rowCount: 1 };
    },
  };
  return { db, log, policies, optIns };
}

test("persisted opt-ins never contain a raw Cumulus ID and survive a restart", async () => {
  const pseud = new Pseudonymizer("p".repeat(32));
  const tenancy = new MemoryTenancy().add(TENANT, ALICE);
  const f = fakeDb();
  const repo = new PgPolicyRepository(f.db);
  const a = new PolicyService(tenancy, { optInKey: optInKeyFor(pseud) });
  await repo.optIn(a, "hrvst", ALICE);
  assert.ok(!JSON.stringify(f.log).includes(ALICE));
  assert.match(f.optIns[0].subject_id, /^sub_[0-9a-f]{32}$/);

  f.policies.push({ id: "pol1", tenant_id: TENANT, product: "hrvst", purposes: ["product_analytics"], retention_days: null, export_allowed: false, source_rights: "first_party" });
  const b = new PolicyService(tenancy, { optInKey: optInKeyFor(pseud) });
  assert.deepEqual(await repo.load(b), { records: 1, optIns: 1 });
  assert.ok(b.hasOptIn("hrvst", ALICE));
  assert.ok(!b.hasOptIn("hrvst", BOB));
  assert.equal(b.get(TENANT, "hrvst")?.exportAllowed, false);

  // Without pseudonymous keys, persisting is refused rather than storing raw ids.
  await assert.rejects(repo.optIn(new PolicyService(tenancy), "hrvst", ALICE), /optInKeyFor/);
  // Military products never reach the table.
  await assert.rejects(repo.save(b, { id: "x", tenant_id: TENANT, product: "eon", purposes: ["security"], exportAllowed: false, sourceRights: "first_party" }));
  assert.ok(!f.log.some((l) => l.tag === "policy.upsert"));
});

test("ontology mirror follows uploads, shares and deletion in Postgres", async () => {
  const k = kit();
  const f = fakeDb();
  k.platform.pipeline.mirror = new PgOntologyMirror(f.db);
  const drive = new CloudDriveAdapter(k.collector);
  drive.uploaded({ tenant_id: TENANT, file_id: "file_pg", owner_cid: ALICE, size_bytes: 3, media_type: "text/csv", version: 1 });
  drive.shared(TENANT, "file_pg", ALICE, BOB, "viewer");
  await k.collector.flush();
  drive.deleted(TENANT, "file_pg", ALICE);
  await k.collector.flush();
  const tags = f.log.map((l) => l.tag);
  for (const t of ["object.upsert", "link.insert", "object.delete", "link.delete_touching", "deletion.log"]) assert.ok(tags.includes(t), t);
  assert.equal(tags.filter((t) => t === "BEGIN").length, tags.filter((t) => t === "COMMIT").length);
  assert.ok(!JSON.stringify(f.log).includes(ALICE), "no raw Cumulus ID sent to Postgres");
});

test("ontology mirror rolls back on failure", async () => {
  const f = fakeDb("object.upsert");
  const m = new PgOntologyMirror(f.db);
  await assert.rejects(
    m.apply([{ op: "upsert", object: { type: "File", id: "f", tenant_id: "t", readers: [], owner: null, classification: "internal", properties: {}, source_events: [], updated_at: "2026-11-12T00:00:00Z" } }]),
  );
  assert.deepEqual(f.log.map((l) => l.tag), ["BEGIN", "object.upsert", "ROLLBACK"]);
});

test("Cumulus ID tenancy: organization membership with a short cache", async () => {
  let calls = 0;
  let now = 0;
  const orgOf: Record<string, string | null> = { [ALICE]: "org_acme", [BOB]: null };
  const t = new CidTenancy({
    membership: async (cid) => {
      calls++;
      return orgOf[cid] ? { id: orgOf[cid]! } : null;
    },
    personalTenantOf: (cid) => `personal_${cid.length}`,
    ttlMs: 1000,
    now: () => now,
  });
  assert.equal(await t.isMember("org_acme", ALICE), true);
  assert.equal(await t.isMember("org_other", ALICE), false);
  assert.equal(calls, 1, "cached");
  assert.equal(await t.isMember("org_acme", BOB), false);
  assert.equal(await t.isMember(`personal_${BOB.length}`, BOB), true);
  orgOf[ALICE] = null; // membership revoked
  assert.equal(await t.isMember("org_acme", ALICE), true, "still cached");
  now = 2000;
  assert.equal(await t.isMember("org_acme", ALICE), false, "revocation applies after the TTL");
});

function env(id: string): Envelope {
  return {
    event_id: id,
    schema_version: "1.0",
    product: "fabric",
    event_type: "call.quality",
    occurred_at: "2026-11-12T10:00:00Z",
    received_at: "2026-11-12T10:00:01Z",
    tenant_id: "t1",
    subject_id: null,
    object_id: null,
    purpose: "service_operation",
    policy_ref: "pol",
    classification: "internal",
    payload: {},
  };
}

test("two gateway processes sharing a bucket store each event once", async () => {
  const store = new MemoryObjectStore();
  const a = new Lakehouse(store);
  const b = new Lakehouse(store);
  const batch = ["e1", "e2", "e3"].map((id) => ({ envelope: env(id), retentionDays: 30 }));
  const [ra, rb] = await Promise.all([a.appendRaw(batch), b.appendRaw(batch)]);
  assert.equal(ra.added.length + rb.added.length, 3);
  assert.equal(ra.duplicates.length + rb.duplicates.length, 3);
  assert.equal((await a.rawEvents()).length, 3);
});

test("a failed raw write releases its claims, and stale claims are recovered", async () => {
  const store = new MemoryObjectStore();
  const lh = new Lakehouse(store);
  const orig = store.putIf.bind(store);
  let breakMeta = true;
  store.putIf = async (key, bytes, etag) => {
    if (breakMeta && key.endsWith("metadata.json")) throw new Error("bucket unavailable");
    return orig(key, bytes, etag);
  };
  await assert.rejects(lh.appendRaw([{ envelope: env("x1"), retentionDays: 30 }]));
  breakMeta = false;
  assert.deepEqual((await lh.appendRaw([{ envelope: env("x1"), retentionDays: 30 }])).added.map((e) => e.event_id), ["x1"]);

  // A writer that crashed after claiming: claim exists, event never stored.
  const { dedupeKey } = await import("./lakehouse.ts");
  await store.put(dedupeKey("t1", "x2"), new TextEncoder().encode("pending:2020-01-01T00:00:00.000Z"));
  assert.deepEqual((await lh.appendRaw([{ envelope: env("x2"), retentionDays: 30 }])).added.map((e) => e.event_id), ["x2"]);
  // A fresh claim by a live writer is respected.
  await store.put(dedupeKey("t1", "x3"), new TextEncoder().encode(`pending:${new Date().toISOString()}`));
  assert.deepEqual((await lh.appendRaw([{ envelope: env("x3"), retentionDays: 30 }])).duplicates, ["x3"]);
  assert.ok(PreconditionFailed);
});

test("retention purge also expires dedupe markers", async () => {
  const store = new MemoryObjectStore();
  const lh = new Lakehouse(store);
  await lh.appendRaw([{ envelope: env("r1"), retentionDays: 1 }]);
  assert.equal((await store.list("dedupe/")).length, 1);
  const r = await lh.purgeExpired(new Date("2026-12-01T00:00:00Z"));
  assert.equal(r.raw, 1);
  assert.equal((await store.list("dedupe/")).length, 0);
});
