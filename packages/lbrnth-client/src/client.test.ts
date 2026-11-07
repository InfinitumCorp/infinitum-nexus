import { test } from "node:test";
import assert from "node:assert/strict";
import { createLabyrinthClient, LABYRINTH_PRODUCTS, labyrinthProduct, proxyLabyrinthRequest } from "./index.ts";

test("every website brand is registered and aliases share the canonical namespace", () => {
  const brands = ["FIRM", "DAEMON", "ARCHITECT", "VEIL", "THRONE", "SPECTRE", "SLUG", "SERAPHIM", "SCALUS", "tokens", "POLLEN", "ORBIS", "ODIN", "METATRON", "HRVST", "FLOWER", "firmament-network", "FABRIC", "EON", "EIDETIC", "Cumulus Exchange", "CHERUBIM", "AZRAIL", "ARGUS", "AETHER", "NEMESIS", "firm-wallet", "CNDCTR"];
  for (const brand of brands) assert.ok(labyrinthProduct(brand));
  assert.equal(labyrinthProduct("CNDCTR"), "architect"); assert.equal(labyrinthProduct("SCALUS"), "scalvs");
  assert.equal(LABYRINTH_PRODUCTS.filter(p => p.implementation === null).length, 5);
  assert.throws(() => labyrinthProduct("__proto__"));
});

test("typed clients refuse insecure endpoints, avoid redirects and request only explicit saves", async () => {
  assert.throws(() => createLabyrinthClient("veil", { endpoint: "http://public.example/api/labyrinth" }));
  assert.throws(() => createLabyrinthClient("veil", { endpoint: "https://user:secret@cid.example/api/labyrinth" }));
  const client = createLabyrinthClient("veil", { endpoint: "https://cid.example/api/labyrinth", token: () => "cid-session", fetch: async (_url, init) => {
    assert.equal(init?.redirect, "error"); assert.equal(new Headers(init?.headers).get("authorization"), "Bearer cid-session");
    assert.equal(JSON.parse(String(init?.body)).product, "veil"); return Response.json([]);
  } });
  assert.deepEqual(await client.repositories(), []);
});

test("Worker relay requires actual CID bearer, bounds bodies and cannot spoof product identity", async () => {
  const make = (headers: Record<string, string> = {}, body: unknown = { action: "list", product: "other" }) => new Request("https://odin.example/api/labyrinth", { method: "POST", headers: { "content-type": "application/json", "x-labyrinth": "1", ...headers }, body: JSON.stringify(body) });
  assert.equal((await proxyLabyrinthRequest(make(), "https://cid.example/api/labyrinth", "odin")).status, 401);
  assert.equal((await proxyLabyrinthRequest(make({ authorization: "Bearer token" }), undefined, "odin")).status, 503);
  const reply = await proxyLabyrinthRequest(make({ authorization: "Bearer real-session", cookie: "private", "cf-access-jwt-assertion": "not-cid" }), "https://cid.example/api/labyrinth", "odin", async (_url, init) => {
    const headers = new Headers(init?.headers); assert.equal(headers.get("authorization"), "Bearer real-session");
    assert.equal(headers.get("cookie"), null); assert.equal(headers.get("cf-access-jwt-assertion"), null);
    assert.equal(JSON.parse(String(init?.body)).product, "odin"); assert.equal(init?.redirect, "error"); return Response.json({ ok: true });
  }); assert.equal(reply.status, 200);
  assert.equal((await proxyLabyrinthRequest(make({ authorization: "Bearer token" }, { huge: "x".repeat(2 * 1024 * 1024) }), "https://cid.example/api/labyrinth", "odin")).status, 413);
});
