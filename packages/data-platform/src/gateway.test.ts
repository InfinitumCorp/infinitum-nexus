// © Infinitum Corporation®. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { signedHeaders } from "./signing.ts";
import { ALICE, kit, MALLORY, TENANT, TEST_SECRET } from "./testkit.test-util.ts";

const base = {
  schema_version: "1.0",
  product: "cumulus-cloud",
  event_type: "file.uploaded",
  occurred_at: "2026-11-12T10:00:00Z",
  tenant_id: TENANT,
  subject_cid: ALICE,
  object_id: "file_1",
  purpose: "service_operation",
  payload: { size_bytes: 5, media_type: "text/plain" },
};

async function post(k: ReturnType<typeof kit>, events: unknown[], headers?: Record<string, string>) {
  const body = JSON.stringify({ events });
  return k.platform.gateway.ingest(headers ?? signedHeaders("key_cloud", TEST_SECRET, body), body);
}

test("rejects unsigned, badly signed, stale and replayed requests", async () => {
  const k = kit();
  const body = JSON.stringify({ events: [{ ...base, event_id: "e1" }] });
  assert.equal((await k.platform.gateway.ingest({}, body)).status, 401);
  assert.equal((await k.platform.gateway.ingest(signedHeaders("key_cloud", "x".repeat(40), body), body)).status, 401);
  assert.equal((await k.platform.gateway.ingest(signedHeaders("key_cloud", TEST_SECRET, body, Date.now() - 3_600_000), body)).status, 401);
  const h = signedHeaders("key_cloud", TEST_SECRET, body);
  assert.equal((await k.platform.gateway.ingest(h, body)).status, 200);
  assert.equal((await k.platform.gateway.ingest(h, body)).status, 409);
});

test("clients cannot set server-only fields or send other products' events", async () => {
  const k = kit();
  const r = await post(k, [
    { ...base, event_id: "e1", classification: "public" },
    { ...base, event_id: "e2", subject_id: "sub_forged" },
    { ...base, event_id: "e3", product: "cumulus-mail", event_type: "message.bounced", payload: { reason_code: "x" } },
  ]);
  assert.equal(r.accepted.length, 0);
  assert.deepEqual(r.rejected.map((x) => x.status), [422, 422, 403]);
});

test("forbidden fields, unknown fields and personal data by value are rejected", async () => {
  const k = kit();
  const r = await post(k, [
    { ...base, event_id: "e1", payload: { ...base.payload, body: "hello" } },
    { ...base, event_id: "e2", payload: { ...base.payload, colour: "red" } },
    { ...base, event_id: "e3", payload: { ...base.payload, media_type: "text/plain", sha256: "alice@example.com" } },
  ]);
  assert.equal(r.accepted.length, 0);
  assert.match(JSON.stringify(r.rejected[2].problems), /personal data \(email\)/);
});

test("policy comes from authoritative records, not from the event", async () => {
  const k = kit();
  const r = await post(k, [
    { ...base, event_id: "e1", subject_cid: MALLORY }, // not a member of org_acme
    { ...base, event_id: "e2", tenant_id: "org_nopolicy" },
    { ...base, event_id: "e3", purpose: "exchange_licensing" }, // not allowed by contract
    { ...base, event_id: "e4", event_type: "file.shared", payload: { grantee_cid: MALLORY, role: "viewer" } },
  ]);
  assert.equal(r.accepted.length, 0);
  assert.ok(r.rejected.every((x) => x.status === 403));
});

test("military products are refused at every layer", () => {
  const k = kit();
  assert.throws(() => k.credentials.add({ key_id: "k2", product: "aether", secret: TEST_SECRET }));
  assert.throws(() =>
    k.platform.policy.put({ id: "p", tenant_id: TENANT, product: "odin", purposes: ["security"], exportAllowed: false, sourceRights: "first_party" }),
  );
});

test("quota limits a credential per minute", async () => {
  const k = kit();
  k.credentials.add({ key_id: "key_small", product: "cumulus-cloud", secret: TEST_SECRET, quota_per_minute: 1 });
  const body = JSON.stringify({ events: [{ ...base, event_id: "q1" }, { ...base, event_id: "q2" }] });
  const r = await k.platform.gateway.ingest(signedHeaders("key_small", TEST_SECRET, body), body);
  assert.equal(r.status, 429);
});

test("SDK retries transient failures and the gateway stores each event once", async () => {
  const k = kit();
  let fails = 2;
  const { Collector } = await import("./sdk.ts");
  const c = new Collector({
    endpoint: "https://collect.example/v1/events",
    keyId: "key_cloud",
    secret: TEST_SECRET,
    product: "cumulus-cloud",
    sleep: async () => {},
    transport: async (_u, init) => {
      const r = await k.platform.gateway.ingest(init.headers, init.body);
      if (fails-- > 0) return { status: 503, json: async () => ({}) }; // stored, but the reply was lost
      return { status: r.status, json: async () => r };
    },
  });
  const id = c.track({ event_type: "file.uploaded", tenant_id: TENANT, subject_cid: ALICE, object_id: "f9", purpose: "billing", payload: { size_bytes: 1, media_type: "image/png" } });
  const r = await c.flush();
  assert.deepEqual(r.duplicates, [id]);
  assert.equal((await k.platform.lakehouse.rawEvents()).length, 1);
});
