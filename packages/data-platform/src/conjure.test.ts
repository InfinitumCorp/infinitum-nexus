// © Infinitum Corporation®. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { fromConjureEnvelope } from "./conjure.ts";
import { createHttpServer } from "./http.ts";
import { signedHeaders } from "./signing.ts";
import { ALICE, kit, MALLORY, TENANT, TEST_SECRET } from "./testkit.test-util.ts";

const conj = (over: Record<string, unknown> = {}) => ({
  eventId: "0b6f0d4e-6f3c-4c1a-9a51-2a6a4b1d9e01",
  product: "cumulus-cloud",
  tenant: TENANT,
  cid: ALICE,
  eventType: "cumulus-cloud.file.uploaded",
  schemaVersion: 1,
  occurredAt: "2026-11-13T09:00:00+01:00",
  region: "US",
  consent: ["ANALYTICS", "ESSENTIAL"],
  objectType: "File",
  objectId: "file_conj",
  payload: { size_bytes: 10, media_type: "text/plain" },
  ...over,
});

test("Conjure envelope maps to the native event; consent is only a request", () => {
  const r = fromConjureEnvelope(conj(), "US");
  assert.ok("event" in r);
  const e = r.event as Record<string, unknown>;
  assert.equal(e.event_type, "file.uploaded");
  assert.equal(e.purpose, "service_operation", "narrowest consent wins");
  assert.equal(e.occurred_at, "2026-11-13T08:00:00.000Z");
  assert.equal(e.subject_cid, ALICE);
  assert.ok(!("consent" in e) && !("region" in e));
});

test("Conjure envelope: region, schema version, uuid and unknown fields are enforced", () => {
  const bad = (over: Record<string, unknown>) => {
    const r = fromConjureEnvelope(conj(over), "US");
    assert.ok("error" in r, JSON.stringify(over));
    return r.error;
  };
  assert.match(bad({ region: "EU" }), /US data only/);
  assert.match(bad({ region: "RU" }), /US data only/);
  assert.match(bad({ schemaVersion: 2 }), /schemaVersion/);
  assert.match(bad({ eventId: "e1" }), /uuid/);
  assert.match(bad({ consent: [] }), /consent/);
  assert.match(bad({ consent: ["EVERYTHING"] }), /no known value/);
  assert.match(bad({ classification: "PUBLIC" }), /unknown field/);
  const eu = fromConjureEnvelope(conj({ region: "EU" }), "EU");
  assert.ok("event" in eu, "an EU gateway accepts EU data");
});

test("POST /api/v1/collect/events: Conjure in, Conjure out, same checks", async () => {
  const k = kit();
  const server = createHttpServer(k.platform, { resolveViewer: async () => null });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/collect/events`;
  const post = async (events: unknown[]) => {
    const body = JSON.stringify({ events });
    const r = await fetch(url, { method: "POST", headers: signedHeaders("key_cloud", TEST_SECRET, body), body });
    return { status: r.status, json: (await r.json()) as { accepted: number; duplicates: number; rejected: { eventId: string; reason: string }[] } };
  };
  try {
    const first = await post([conj()]);
    assert.equal(first.status, 200);
    assert.deepEqual(first.json, { accepted: 1, duplicates: 0, rejected: [] });
    assert.equal((await post([conj()])).json.duplicates, 1, "repeated eventId accepted once");

    const mixed = await post([
      conj({ eventId: "0b6f0d4e-6f3c-4c1a-9a51-2a6a4b1d9e02", region: "EU" }),
      conj({ eventId: "0b6f0d4e-6f3c-4c1a-9a51-2a6a4b1d9e03", cid: MALLORY }),
      conj({ eventId: "0b6f0d4e-6f3c-4c1a-9a51-2a6a4b1d9e04", payload: { size_bytes: 1, media_type: "text/plain", body: "secret" } }),
      conj({ eventId: "0b6f0d4e-6f3c-4c1a-9a51-2a6a4b1d9e05", consent: ["EXCHANGE"] }),
    ]);
    assert.equal(mixed.json.accepted, 0);
    assert.deepEqual(
      mixed.json.rejected.map((r) => r.eventId.slice(-2)),
      ["02", "03", "04", "05"],
    );
    assert.match(mixed.json.rejected[1].reason, /not a member/);
    assert.match(mixed.json.rejected[2].reason, /never collected/);
    assert.match(mixed.json.rejected[3].reason, /exchange_licensing/, "consent cannot widen what the contract allows");

    const unsigned = await fetch(url, { method: "POST", body: JSON.stringify({ events: [conj()] }) });
    assert.equal(unsigned.status, 401);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
