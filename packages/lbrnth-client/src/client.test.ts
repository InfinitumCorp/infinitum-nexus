import { test } from "node:test";
import assert from "node:assert/strict";
import { createLabyrinthClient, LABYRINTH_PRODUCTS, labyrinthEndpointFor, labyrinthProduct, proxyLabyrinthRequest, useLabyrinthServiceBinding } from "./index.ts";

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
    assert.equal(JSON.parse(String(init?.body)).product, "odin"); assert.equal(init?.redirect, "manual"); return Response.json({ ok: true });
  }); assert.equal(reply.status, 200);
  assert.equal((await proxyLabyrinthRequest(make({ authorization: "Bearer token" }, { huge: "x".repeat(2 * 1024 * 1024) }), "https://cid.example/api/labyrinth", "odin")).status, 413);
});

test("Worker relay works on Cloudflare's fetch, which rejects redirect: error, and never follows a redirect", async () => {
  const make = () => new Request("https://product.example/api/labyrinth", { method: "POST", headers: { authorization: "Bearer real-session", "content-type": "application/json", "x-labyrinth": "1" }, body: JSON.stringify({ action: "list" }) });
  // workerd: "Invalid redirect value, must be one of \"follow\" or \"manual\""
  const workerd = (reply: () => Response) => (async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.redirect !== "follow" && init?.redirect !== "manual") throw new TypeError("Invalid redirect value");
    return reply();
  }) as typeof fetch;
  assert.equal((await proxyLabyrinthRequest(make(), "https://cid.example/api/labyrinth", "odin", workerd(() => Response.json([], { status: 200 })))).status, 200);
  assert.equal((await proxyLabyrinthRequest(make(), "https://cid.example/api/labyrinth", "odin", workerd(() => Response.json({ error: "no" }, { status: 401 })))).status, 401);
  const redirected = await proxyLabyrinthRequest(make(), "https://cid.example/api/labyrinth", "odin", workerd(() => new Response(null, { status: 302, headers: { location: "https://evil.example/" } })));
  assert.equal(redirected.status, 502);
  assert.equal(redirected.headers.get("location"), null);
});

test("endpoint map sends Russia to the Russia server and everyone else to the US one", async () => {
  const map = "RU=https://lbrnth.cumuluscloud.app/api/labyrinth,*=https://lbrnth-us.cumuluscloud.app/api/labyrinth";
  assert.equal(labyrinthEndpointFor(map, "RU"), "https://lbrnth.cumuluscloud.app/api/labyrinth");
  assert.equal(labyrinthEndpointFor(map, "ru"), "https://lbrnth.cumuluscloud.app/api/labyrinth");
  assert.equal(labyrinthEndpointFor(map, "US"), "https://lbrnth-us.cumuluscloud.app/api/labyrinth");
  assert.equal(labyrinthEndpointFor(map, null), "https://lbrnth-us.cumuluscloud.app/api/labyrinth");
  assert.equal(labyrinthEndpointFor(map, "T1"), "https://lbrnth-us.cumuluscloud.app/api/labyrinth");
  assert.equal(labyrinthEndpointFor("https://one.example/api/labyrinth", "RU"), "https://one.example/api/labyrinth");
  assert.equal(labyrinthEndpointFor("RU=https://ru.example/api/labyrinth", "DE"), undefined);
  assert.throws(() => labyrinthEndpointFor("Russia=https://x/api", "RU"));
  const seen: string[] = [];
  const fetcher = (async (url: string) => { seen.push(url); return Response.json({ ok: true }); }) as unknown as typeof fetch;
  const req = (country?: string) => new Request("https://p/api/labyrinth", { method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json", "x-labyrinth": "1", ...(country ? { "cf-ipcountry": country } : {}) }, body: "{}" });
  assert.equal((await proxyLabyrinthRequest(req("RU"), map, "architect", fetcher)).status, 200);
  assert.equal((await proxyLabyrinthRequest(req("GB"), map, "architect", fetcher)).status, 200);
  assert.deepEqual(seen, ["https://lbrnth.cumuluscloud.app/api/labyrinth", "https://lbrnth-us.cumuluscloud.app/api/labyrinth"]);
  assert.equal((await proxyLabyrinthRequest(req("GB"), "RU=https://ru.example/api/labyrinth", "architect", fetcher)).status, 503);
  assert.equal((await proxyLabyrinthRequest(req("GB"), "RU=http://insecure.example/api,*=https://x.example/api", "architect", fetcher)).status, 200);
  assert.equal((await proxyLabyrinthRequest(req("RU"), "RU=http://insecure.example/api,*=https://x.example/api", "architect", fetcher)).status, 503);
});

test("relay calls to a host with a service binding stay inside Cloudflare; others use fetch", async () => {
  const viaBinding: string[] = [];
  const binding = { fetch: async (input: string | Request) => { viaBinding.push(String(input)); return Response.json({ via: "binding" }); } };
  const req = () => new Request("https://p/api/labyrinth", { method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json", "x-labyrinth": "1", "cf-ipcountry": "US" }, body: "{}" });
  useLabyrinthServiceBinding("lbrnth-us.cumuluscloud.app", binding);
  try {
    const res = await proxyLabyrinthRequest(req(), "RU=https://lbrnth.cumuluscloud.app/api/labyrinth,*=https://lbrnth-us.cumuluscloud.app/api/labyrinth", "architect");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { via: "binding" });
    assert.deepEqual(viaBinding, ["https://lbrnth-us.cumuluscloud.app/api/labyrinth"]);
    // An explicit fetcher still wins (tests and Node callers).
    const seen: string[] = [];
    await proxyLabyrinthRequest(req(), "https://lbrnth-us.cumuluscloud.app/api/labyrinth", "architect", (async (u: string) => { seen.push(u); return Response.json({}); }) as unknown as typeof fetch);
    assert.equal(seen.length, 1);
    assert.equal(viaBinding.length, 1);
  } finally {
    useLabyrinthServiceBinding("lbrnth-us.cumuluscloud.app", undefined);
  }
  const removed = await proxyLabyrinthRequest(req(), "https://lbrnth-us.cumuluscloud.app/api/labyrinth", "architect", (async () => Response.json({ via: "fetch" })) as unknown as typeof fetch);
  assert.deepEqual(await removed.json(), { via: "fetch" });
});
