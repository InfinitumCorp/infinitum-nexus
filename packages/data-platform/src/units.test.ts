// © Infinitum Corporation®. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectPii, redact } from "./pii.ts";
import { runChecks } from "./quality.ts";
import { dpCountDistinct, PrivacyBudget } from "./privacy.ts";
import { defaultCatalog } from "./catalog.ts";
import { FileObjectStore, MemoryObjectStore, checkKey } from "./storage.ts";
import { Table } from "./table.ts";
import { parseClientEvent } from "./envelope.ts";
import { Pseudonymizer } from "./policy.ts";

test("PII recognizers find real values and skip look-alikes", () => {
  assert.deepEqual(detectPii("mail me at a.b@example.org").map((f) => f.kind), ["email"]);
  assert.deepEqual(detectPii("card 4111 1111 1111 1111").map((f) => f.kind), ["credit_card"]);
  assert.deepEqual(detectPii("not a card 4111 1111 1111 1112").filter((f) => f.kind === "credit_card"), []);
  assert.deepEqual(detectPii("GB82 WEST 1234 5698 7654 32").map((f) => f.kind), ["iban"]);
  assert.deepEqual(detectPii("from 192.168.1.20").map((f) => f.kind), ["ip_address"]);
  assert.deepEqual(detectPii("version 999.1.2.3"), []);
  assert.deepEqual(detectPii("ssn 123-45-6789").map((f) => f.kind), ["us_ssn"]);
  assert.deepEqual(detectPii("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"), []);
  assert.equal(redact("call +1 415 555 0134 or a@b.co"), "call <PHONE> or <EMAIL>");
});

test("quality checks report completeness, uniqueness, range and freshness", () => {
  const now = new Date("2026-11-12T12:00:00Z");
  const rows = [
    { id: "a", n: 1, t: "2026-11-12T11:00:00Z" },
    { id: "a", n: -1, t: "2026-11-12T10:00:00Z" },
    { id: null, n: 3, t: "2026-11-11T10:00:00Z" },
  ];
  const r = runChecks(
    "x",
    rows,
    [
      { kind: "completeness", column: "id", min: 0.9 },
      { kind: "uniqueness", columns: ["id"] },
      { kind: "range", column: "n", min: 0 },
      { kind: "freshness", column: "t", maxAgeHours: 2 },
      { kind: "row_count", min: 1 },
    ],
    now,
  );
  assert.deepEqual(r.results.map((x) => x.ok), [false, false, false, true, true]);
  assert.equal(r.ok, false);
});

test("differential privacy: bounded contribution, budget, suppression", () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ p: `p${i % 25}`, g: i % 2 ? "pdf" : "png" }));
  const budget = new PrivacyBudget(1);
  const out = dpCountDistinct(rows, { dataset: "d", budget, epsilon: 0.5, person: (r) => r.p, group: (r) => r.g, noise: () => 0 });
  // Each person counts in at most one group: 25 people total, not 50 rows.
  assert.equal([...out.values()].reduce((a, b) => a + b, 0), 25);
  dpCountDistinct(rows, { dataset: "d", budget, epsilon: 0.5, person: (r) => r.p, group: (r) => r.g });
  assert.throws(() => dpCountDistinct(rows, { dataset: "d", budget, epsilon: 0.1, person: (r) => r.p, group: (r) => r.g }), /exhausted/);
  const small = dpCountDistinct([{ p: "x", g: "rare" }], { dataset: "e", budget, epsilon: 0.5, person: (r) => r.p, group: (r) => r.g, noise: () => 0 });
  assert.equal(small.size, 0);
});

test("catalog lineage and downstream", () => {
  const c = defaultCatalog();
  assert.deepEqual(c.lineage("curated.files"), ["normalized.events", "raw.events"]);
  assert.deepEqual(c.downstream("raw.events"), ["normalized.events", "curated.files"]);
  assert.equal(c.search("pseudonym")[0].id, "raw.events");
});

test("object keys cannot escape the store", () => {
  for (const k of ["../x", "a/../b", "/abs", "a//b", "a/", "a\\b"]) assert.throws(() => checkKey(k));
});

test("table purge rewrites files and expires history on disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dp-"));
  try {
    for (const store of [new MemoryObjectStore(), new FileObjectStore(dir)]) {
      const t = new Table(store, "raw/test");
      await t.append([{ k: 1, product: "p", occurred_at: "2026-01-01" }, { k: 2, product: "p", occurred_at: "2026-01-01" }], () => "product=p/date=2026-01-01");
      await t.append([{ k: 3 }], () => "product=p/date=2026-01-02");
      assert.equal((await t.metadata()).snapshots.length, 2);
      assert.equal(await t.deleteWhere((r) => r.k === 2, "test"), 1);
      assert.deepEqual((await t.scan()).map((r) => r.k).sort(), [1, 3]);
      const m = await t.metadata();
      assert.equal(m.snapshots.length, 1);
      const files = (await store.list("tables/raw/test/data/")).length;
      assert.equal(files, m.snapshots[0].data_files.length, "no orphaned data files");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("envelope rejects bad timestamps and non-scalar payloads", () => {
  const ok = {
    event_id: "e1",
    schema_version: "1.0",
    product: "fabric",
    event_type: "call.quality",
    occurred_at: "2026-11-12T10:00:00.123Z",
    tenant_id: "t1",
    purpose: "service_operation",
    payload: { jitter_ms: 3.2 },
  };
  assert.ok(parseClientEvent(ok));
  assert.throws(() => parseClientEvent({ ...ok, occurred_at: "2026-11-12 10:00" }));
  assert.throws(() => parseClientEvent({ ...ok, payload: { a: { nested: 1 } } }));
  assert.throws(() => parseClientEvent({ ...ok, payload: { a: Infinity } }));
});

test("pseudonyms are stable within a tenant and differ across tenants", () => {
  const p = new Pseudonymizer("k".repeat(32));
  assert.equal(p.subject("t1", "cid_a"), p.subject("t1", "cid_a"));
  assert.notEqual(p.subject("t1", "cid_a"), p.subject("t2", "cid_a"));
  assert.throws(() => new Pseudonymizer("short"));
});
