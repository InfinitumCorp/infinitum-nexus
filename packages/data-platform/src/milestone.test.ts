// © Infinitum Corporation®. All rights reserved.
/**
 * Milestone 1: a Cloud upload produces an event, reaches the lakehouse once, appears as an
 * authorized ontology object, and disappears from derived indexes when deleted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CloudDriveAdapter } from "./adapters/cloud.ts";
import { ALICE, BOB, kit, MALLORY, TENANT } from "./testkit.test-util.ts";

test("milestone 1: upload → lakehouse once → authorized object → deletion propagates", async () => {
  const k = kit();
  const p = k.platform;
  const drive = new CloudDriveAdapter(k.collector);
  const alice = { tenant_id: TENANT, subject_id: p.pseudonymizer.subject(TENANT, ALICE) };
  const bob = { tenant_id: TENANT, subject_id: p.pseudonymizer.subject(TENANT, BOB) };
  const mallory = { tenant_id: TENANT, subject_id: p.pseudonymizer.subject(TENANT, MALLORY) };
  const outsider = { tenant_id: "org_other", subject_id: p.pseudonymizer.subject("org_other", MALLORY) };

  // 1. A Cloud upload produces an event.
  const meta = { tenant_id: TENANT, file_id: "file_q3report", owner_cid: ALICE, size_bytes: 48213, media_type: "application/pdf", version: 1, folder_id: "fld_finance" };
  const eventId = drive.uploaded(meta, "2026-11-12T10:00:00Z");
  const r1 = await k.collector.flush();
  assert.deepEqual(r1.accepted, [eventId]);

  // 2. It reaches the lakehouse once, even when the Drive hook fires again.
  drive.uploaded(meta, "2026-11-12T10:00:00Z");
  const r2 = await k.collector.flush();
  assert.deepEqual(r2.accepted, []);
  assert.deepEqual(r2.duplicates, [eventId]);
  const raw = await p.lakehouse.rawEvents((e) => e.object_id === "file_q3report");
  assert.equal(raw.length, 1);
  assert.equal((await p.lakehouse.normalized.scan((r) => r.object_id === "file_q3report")).length, 1);
  // No raw Cumulus ID anywhere in storage.
  assert.ok(!k.store.dump().includes(ALICE));
  assert.equal(raw[0].subject_id, alice.subject_id);
  assert.equal(raw[0].classification, "confidential");
  assert.equal(raw[0].policy_ref, "pol_acme_cloud");

  // 3. It appears as an authorized ontology object.
  const obj = p.ontology.get(alice, "File", "file_q3report");
  assert.ok(obj);
  assert.equal(obj.properties.media_type, "application/pdf");
  assert.deepEqual(obj.source_events, [eventId]);
  assert.equal(p.ontology.get(bob, "File", "file_q3report"), undefined, "not shared with Bob yet");
  assert.equal(p.ontology.get(mallory, "File", "file_q3report"), undefined);
  assert.equal(p.ontology.get(outsider, "File", "file_q3report"), undefined);
  assert.equal(p.ontology.search(alice, "pdf").length, 1);
  assert.equal(p.ontology.search(bob, "pdf").length, 0);

  // Access follows the Drive's sharing.
  drive.shared(TENANT, "file_q3report", ALICE, BOB, "viewer", "2026-11-12T10:05:00Z");
  await k.collector.flush();
  assert.ok(p.ontology.get(bob, "File", "file_q3report"));
  assert.equal(p.ontology.search(bob, "pdf").length, 1);
  drive.unshared(TENANT, "file_q3report", ALICE, BOB, "2026-11-12T10:06:00Z");
  await k.collector.flush();
  assert.equal(p.ontology.get(bob, "File", "file_q3report"), undefined);

  assert.equal((await p.lakehouse.curatedFiles.scan()).length, 1);
  assert.equal(p.catalog.get("curated.files")?.quality?.ok, true);

  // 4. It disappears from derived indexes when deleted.
  const delId = drive.deleted(TENANT, "file_q3report", ALICE, "2026-11-12T11:00:00Z");
  const r3 = await k.collector.flush();
  assert.deepEqual(r3.accepted, [delId]);
  assert.equal(p.ontology.get(alice, "File", "file_q3report"), undefined);
  assert.equal(p.ontology.search(alice, "pdf").length, 0);
  assert.equal(p.ontology.search(alice, "file_q3report").length, 0);
  assert.equal(p.ontology.indexSize(), 0);
  assert.equal(p.ontology.linksOf(alice, "File", "file_q3report").length, 0);
  assert.equal((await p.lakehouse.curatedFiles.scan()).length, 0);
  const normLeft = await p.lakehouse.normalized.scan((r) => r.object_id === "file_q3report");
  assert.deepEqual(normLeft.map((r) => r.event_type), ["file.deleted"], "only the deletion tombstone remains");
  const rawLeft = await p.lakehouse.rawEvents((e) => e.object_id === "file_q3report");
  assert.deepEqual(rawLeft.map((e) => e.event_type), ["file.deleted"]);
  // Physically gone: no stored byte mentions the old metadata.
  assert.ok(!k.store.dump().includes("fld_finance"));
  assert.ok(!k.store.dump().includes("application/pdf"));
  const meta3 = await p.lakehouse.raw.metadata();
  assert.equal(meta3.snapshots.length, 1, "history expired, no time travel to deleted rows");
  assert.ok(p.catalog.get("curated.files")!.deletions.some((d) => d.object_id === "file_q3report"));

  // Replaying the raw zone does not resurrect the file.
  await p.pipeline.replay();
  assert.equal(p.ontology.get(alice, "File", "file_q3report"), undefined);
});

test("only the owner can share or delete a file", async () => {
  const k = kit();
  const p = k.platform;
  const drive = new CloudDriveAdapter(k.collector);
  drive.uploaded({ tenant_id: TENANT, file_id: "file_a", owner_cid: ALICE, size_bytes: 10, media_type: "text/plain", version: 1 });
  drive.deleted(TENANT, "file_a", BOB);
  drive.shared(TENANT, "file_a", BOB, BOB, "editor");
  await k.collector.flush();
  const alice = { tenant_id: TENANT, subject_id: p.pseudonymizer.subject(TENANT, ALICE) };
  const bob = { tenant_id: TENANT, subject_id: p.pseudonymizer.subject(TENANT, BOB) };
  assert.ok(p.ontology.get(alice, "File", "file_a"));
  assert.equal(p.ontology.get(bob, "File", "file_a"), undefined);
});
