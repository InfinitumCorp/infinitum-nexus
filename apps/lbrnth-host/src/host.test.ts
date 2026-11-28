import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { hostConfigFromEnv } from "./config.ts";
import { labyrinthHostServer } from "./server.ts";

test("configuration fails closed and never invents a secret", () => {
  assert.deepEqual(hostConfigFromEnv({}).missing, ["LBRNTH_MASTER_KEY", "DATABASE_URL", "CID_DIRECTORY_KEY"]);
  const base = { LBRNTH_MASTER_KEY: Buffer.alloc(32, 1).toString("base64"), DATABASE_URL: "postgresql://u@db.example.com:5432/postgres", CID_DIRECTORY_KEY: "k".repeat(40) };
  const ok = hostConfigFromEnv({ ...base, LBRNTH_ENTITLED_ORGS: " org_a, ,org_b " });
  assert.equal(ok.config?.directoryUrl, "https://id.cumuluscloud.app/api/id/labyrinth-directory");
  assert.deepEqual(ok.config?.entitledOrgs(), ["org_a", "org_b"]);
  assert.equal(ok.config?.databaseCa, undefined);
  const supabase = hostConfigFromEnv({ ...base, DATABASE_URL: "postgresql://u@aws-1-eu-west-1.pooler.supabase.com:5432/postgres" });
  assert.match(supabase.config?.databaseCa ?? "", /BEGIN CERTIFICATE/);
  assert.throws(() => hostConfigFromEnv({ ...base, LBRNTH_MASTER_KEY: Buffer.alloc(31, 1).toString("base64") }), /32-byte/);
  assert.throws(() => hostConfigFromEnv({ ...base, DATABASE_URL: "mysql://x" }), /postgres/);
  assert.throws(() => hostConfigFromEnv({ ...base, CID_DIRECTORY_KEY: "short" }), /32-512/);
});

test("unconfigured service is healthy, answers 503 on the API and 404 elsewhere", async () => {
  const server = labyrinthHostServer(undefined);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, configured: false });
    assert.equal(health.headers.get("x-frame-options"), "DENY");
    const api = await fetch(`${base}/api/labyrinth`, { method: "POST", headers: { "content-type": "application/json", "x-labyrinth": "1", authorization: "Bearer x" }, body: "{}" });
    assert.equal(api.status, 503);
    assert.equal(api.headers.get("access-control-allow-origin"), null);
    assert.equal((await fetch(`${base}/labyrinth`)).status, 404);
  } finally {
    await new Promise<void>(r => server.close(() => r()));
  }
});
