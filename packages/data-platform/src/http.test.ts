// © Infinitum Corporation®. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createHttpServer } from "./http.ts";
import { signedHeaders } from "./signing.ts";
import { ALICE, BOB, kit, TENANT, TEST_SECRET } from "./testkit.test-util.ts";

test("HTTP: signed ingest, authorized reads, 404 for others", async () => {
  const k = kit();
  const p = k.platform;
  // Test-only viewer resolution: a real deployment verifies a Cumulus ID session here.
  const sessions: Record<string, string> = { "sess-alice": ALICE, "sess-bob": BOB };
  const server = createHttpServer(p, {
    resolveViewer: async (req) => {
      const cid = sessions[String(req.headers.authorization ?? "").replace(/^Bearer /, "")];
      return cid ? { tenant_id: TENANT, subject_id: p.pseudonymizer.subject(TENANT, cid) } : null;
    },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const body = JSON.stringify({
      events: [
        {
          event_id: "e1",
          schema_version: "1.0",
          product: "cumulus-cloud",
          event_type: "file.uploaded",
          occurred_at: "2026-11-12T10:00:00Z",
          tenant_id: TENANT,
          subject_cid: ALICE,
          object_id: "file_h",
          purpose: "service_operation",
          payload: { size_bytes: 9, media_type: "image/png" },
        },
      ],
    });
    const ing = await fetch(`${base}/v1/events`, { method: "POST", headers: signedHeaders("key_cloud", TEST_SECRET, body), body });
    assert.equal(ing.status, 200);

    assert.equal((await fetch(`${base}/v1/objects/File/file_h`)).status, 401);
    const a = await fetch(`${base}/v1/objects/File/file_h`, { headers: { authorization: "Bearer sess-alice" } });
    assert.equal(a.status, 200);
    assert.equal(((await a.json()) as { object: { id: string } }).object.id, "file_h");
    const b = await fetch(`${base}/v1/objects/File/file_h`, { headers: { authorization: "Bearer sess-bob" } });
    assert.equal(b.status, 404);
    const s = await fetch(`${base}/v1/search?q=png`, { headers: { authorization: "Bearer sess-bob" } });
    assert.deepEqual(((await s.json()) as { results: unknown[] }).results, []);
    const cat = await fetch(`${base}/v1/catalog`, { headers: { authorization: "Bearer sess-alice" } });
    assert.equal(cat.status, 200);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
