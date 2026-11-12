import { test } from "node:test";
import assert from "node:assert/strict";
import { directoryFetch, handle } from "./worker.ts";
import type { Env } from "./worker.ts";

const ctx = { waitUntil() {} };
const configured: Env = {
  HYPERDRIVE: { connectionString: "postgres://u:p@127.0.0.1:1/db" },
  LBRNTH_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
  CID_DIRECTORY_KEY: "k".repeat(40),
};
const post = (headers: Record<string, string>, body = "{}") => new Request("https://lbrnth-us.cumuluscloud.app/api/labyrinth", { method: "POST", headers, body });

test("health says whether the host is configured, never why", async () => {
  const up = await handle(new Request("https://x/health"), configured, ctx);
  assert.equal(up.status, 200);
  assert.deepEqual(await up.json(), { ok: true, configured: true, region: "us" });
  const down = await handle(new Request("https://x/health"), { HYPERDRIVE: { connectionString: "" } }, ctx);
  assert.deepEqual(await down.json(), { ok: true, configured: false, region: "us" });
  assert.equal(up.headers.get("x-frame-options"), "DENY");
});

test("only /api/labyrinth and /health exist", async () => {
  assert.equal((await handle(new Request("https://x/"), configured, ctx)).status, 404);
  assert.equal((await handle(new Request("https://x/_synapse/admin"), configured, ctx)).status, 404);
});

test("unconfigured host answers 503", async () => {
  const res = await handle(post({ "content-type": "application/json", "x-labyrinth": "1", authorization: "Bearer abc" }), { HYPERDRIVE: { connectionString: "" } }, ctx);
  assert.equal(res.status, 503);
});

test("bad master key keeps the API off instead of crashing", async () => {
  const res = await handle(post({ "content-type": "application/json", "x-labyrinth": "1", authorization: "Bearer abc" }), { ...configured, LBRNTH_MASTER_KEY: "short" }, ctx);
  assert.equal(res.status, 503);
});

test("POST, JSON, the Labyrinth header and a bearer are all required", async () => {
  assert.equal((await handle(new Request("https://x/api/labyrinth"), configured, ctx)).status, 405);
  assert.equal((await handle(post({ "content-type": "application/json", authorization: "Bearer abc" }), configured, ctx)).status, 403);
  assert.equal((await handle(post({ "content-type": "text/plain", "x-labyrinth": "1", authorization: "Bearer abc" }), configured, ctx)).status, 403);
  assert.equal((await handle(post({ "content-type": "application/json", "x-labyrinth": "1" }), configured, ctx)).status, 401);
  assert.equal((await handle(post({ "content-type": "application/json", "x-labyrinth": "1", authorization: "Bearer abc" }, "{not json"), configured, ctx)).status, 400);
});

test("oversized commands are refused before parsing", async () => {
  const big = JSON.stringify({ pad: "x".repeat(2 * 1024 * 1024 + 10) });
  const res = await handle(post({ "content-type": "application/json", "x-labyrinth": "1", authorization: "Bearer abc" }, big), configured, ctx);
  assert.equal(res.status, 413);
});

test("directory fetch uses the service binding, never follows redirects", async () => {
  const seen: RequestInit[] = [];
  const binding = { fetch: (async (_u: string, init: RequestInit) => { seen.push(init); return new Response("{}", { status: 200 }); }) as unknown as typeof fetch };
  const res = await directoryFetch(binding)("https://id.cumuluscloud.app/api/id/labyrinth-directory", { method: "POST", redirect: "error" });
  assert.equal(res.status, 200);
  assert.equal(seen[0].redirect, "manual");
  const redirecting = { fetch: (async () => new Response(null, { status: 302, headers: { location: "https://evil.example" } })) as unknown as typeof fetch };
  await assert.rejects(directoryFetch(redirecting)("https://id.cumuluscloud.app/x", { method: "POST" }), /redirect refused/);
});
