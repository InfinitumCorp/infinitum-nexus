// © Infinitum Corporation®. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { signedHeaders } from "./signing.ts";
import { ALICE, BOB, kit, TENANT, TEST_SECRET } from "./testkit.test-util.ts";

function hrvstKit() {
  const k = kit();
  k.credentials.add({ key_id: "key_hrvst", product: "hrvst", secret: TEST_SECRET });
  k.platform.policy.put({
    id: "pol_acme_hrvst",
    tenant_id: TENANT,
    product: "hrvst",
    purposes: ["service_operation", "product_analytics", "exchange_licensing", "billing"],
    exportAllowed: true,
    sourceRights: "first_party",
  });
  const send = async (events: unknown[]) => {
    const body = JSON.stringify({ events });
    return k.platform.gateway.ingest(signedHeaders("key_hrvst", TEST_SECRET, body), body);
  };
  return { k, send };
}

const packet = (id: string, cid: string, payload: Record<string, unknown>) => ({
  event_id: id,
  schema_version: "1.0",
  product: "hrvst",
  event_type: "packet.created",
  occurred_at: "2026-11-12T09:00:00Z",
  tenant_id: TENANT,
  subject_cid: cid,
  object_id: `hrv_${id}`,
  purpose: "product_analytics",
  payload,
});

test("HRVST collects nothing until the person opts in", async () => {
  const { k, send } = hrvstKit();
  const r = await send([packet("e1", ALICE, { media_type: "image/jpeg", filtered: true })]);
  assert.equal(r.rejected[0]?.status, 403);
  assert.match(r.rejected[0].reason, /opts in/);
  k.platform.policy.optIn("hrvst", ALICE);
  assert.deepEqual((await send([packet("e2", ALICE, { media_type: "image/jpeg", filtered: true, size_bytes: 2048 })])).accepted, ["e2"]);
  // Bob has not opted in, Alice's opt-in does not cover him.
  assert.equal((await send([packet("e3", BOB, { media_type: "image/jpeg", filtered: true })])).rejected[0]?.status, 403);
  k.platform.policy.optOut("hrvst", ALICE);
  assert.equal((await send([packet("e4", ALICE, { media_type: "image/jpeg", filtered: true })])).rejected[0]?.status, 403);
});

test("HRVST packets must be privacy-filtered and carry no media or location", async () => {
  const { k, send } = hrvstKit();
  k.platform.policy.optIn("hrvst", ALICE);
  const r = await send([
    packet("u1", ALICE, { media_type: "image/jpeg", filtered: false }),
    packet("u2", ALICE, { media_type: "image/jpeg", filtered: true, geohash: "9q8yyk" }),
    packet("u3", ALICE, { media_type: "image/jpeg", filtered: true, location: "37.77,-122.41" }),
    packet("u4", ALICE, { media_type: "image/jpeg", filtered: true, media: "base64..." }),
    packet("u5", ALICE, { media_type: "image/jpeg" }),
  ]);
  assert.equal(r.accepted.length, 0);
  assert.equal(r.rejected.length, 5);
  assert.match(JSON.stringify(r.rejected[0].problems), /must be true/);
  assert.equal((await k.platform.lakehouse.rawEvents()).length, 0);
});

test("withdrawing an HRVST packet purges it from every zone", async () => {
  const { k, send } = hrvstKit();
  k.platform.policy.optIn("hrvst", ALICE);
  await send([
    packet("p1", ALICE, { media_type: "audio/ogg", filtered: true, provenance_ref: "prov_abc123" }),
    { ...packet("p2", ALICE, {}), event_type: "packet.licensed", object_id: "hrv_p1", purpose: "billing", payload: { license_terms: "CDAT-commercial-1y", licensee_id: "brk_1" } },
  ]);
  assert.equal((await k.platform.lakehouse.normalized.scan((r) => r.object_id === "hrv_p1")).length, 2);
  const del = await send([{ ...packet("p3", ALICE, {}), event_type: "packet.deleted", object_id: "hrv_p1", purpose: "service_operation" }]);
  assert.deepEqual(del.accepted, ["p3"]);
  assert.deepEqual((await k.platform.lakehouse.normalized.scan((r) => r.object_id === "hrv_p1")).map((r) => r.event_type), ["packet.deleted"]);
  assert.deepEqual((await k.platform.lakehouse.rawEvents((e) => e.object_id === "hrv_p1")).map((e) => e.event_type), ["packet.deleted"]);
  assert.ok(!k.store.dump().includes("prov_abc123"));
  assert.ok(!k.store.dump().includes("brk_1"));
  assert.ok(k.platform.catalog.get("normalized.events")!.deletions.some((d) => d.object_id === "hrv_p1"));
});
