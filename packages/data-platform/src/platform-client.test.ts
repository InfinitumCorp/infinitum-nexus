// © Infinitum Corporation®. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { PlatformApiError, PlatformClient, type Fetch, type FetchResponse } from "./platform-client.ts";

const TOKEN = "s".repeat(40);

function reply(status: number, body: unknown, headers: Record<string, string> = {}): FetchResponse {
  return {
    status,
    headers: { get: (n: string) => headers[n] ?? headers[n.toLowerCase()] ?? null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function scripted(responses: (FetchResponse | Error)[]) {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  const sleeps: number[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, ...init });
    const next = responses.shift();
    if (!next) throw new Error("no scripted response left");
    if (next instanceof Error) throw next;
    return next;
  };
  const client = new PlatformClient({
    baseUrl: "https://data-api.example.com/",
    productToken: TOKEN,
    fetch,
    sleep: async (ms) => void sleeps.push(ms),
  });
  return { client, calls, sleeps };
}

const conjureError = (name: string, code: string, parameters: Record<string, unknown> = {}) => ({
  errorCode: code,
  errorName: `DataPlatform:${name}`,
  errorInstanceId: "00000000-0000-0000-0000-000000000000",
  parameters,
});

test("sends the product token and JSON, and parses the reply", async () => {
  const { client, calls } = scripted([reply(200, { accepted: 1, duplicates: 0, rejected: [] })]);
  const out = await client.ingest([]);
  assert.deepEqual(out, { accepted: 1, duplicates: 0, rejected: [] });
  assert.equal(calls[0].url, "https://data-api.example.com/api/v1/collect/events");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].body, JSON.stringify({ events: [] }));
});

test("path segments are encoded", async () => {
  const { client, calls } = scripted([reply(200, {}), reply(200, {})]);
  await client.getDataset("spectre.deal/../x");
  await client.createGuestToken("3f6c2a8e-1b7d-4c55-9a0e-2d4f6b8c1e90", "acme", "cid_1");
  assert.equal(calls[0].url, "https://data-api.example.com/api/v1/catalog/datasets/spectre.deal%2F..%2Fx");
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].body, undefined);
  assert.match(calls[1].url, /\/api\/v1\/embed\/dashboards\/3f6c2a8e-[^/]+\/guest-token$/);
  assert.deepEqual(JSON.parse(calls[1].body!), { tenant: "acme", cid: "cid_1" });
});

test("Conjure errors become PlatformApiError and are not retried", async () => {
  const { client, calls } = scripted([reply(404, conjureError("DatasetNotFound", "NOT_FOUND", { name: "x", message: "no such dataset" }))]);
  await assert.rejects(client.getDataset("x"), (e: unknown) => {
    assert.ok(e instanceof PlatformApiError);
    assert.equal(e.status, 404);
    assert.equal(e.errorCode, "NOT_FOUND");
    assert.equal(e.shortName, "DatasetNotFound");
    assert.equal(e.parameters.name, "x");
    assert.match(e.message, /no such dataset/);
    return true;
  });
  assert.equal(calls.length, 1);
});

test("429 and 503 wait for Retry-After, then succeed", async () => {
  const { client, calls, sleeps } = scripted([
    reply(429, conjureError("IngestQuotaExceeded", "CUSTOM_CLIENT"), { "Retry-After": "2" }),
    reply(503, conjureError("StorageQuotaReached", "INTERNAL"), { "Retry-After": "5" }),
    reply(200, { accepted: 3, duplicates: 0, rejected: [] }),
  ]);
  assert.equal((await client.ingest([])).accepted, 3);
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [2000, 5000]);
  // Same body every time, so the same eventIds are resent.
  assert.equal(new Set(calls.map((c) => c.body)).size, 1);
});

test("a Retry-After longer than the limit is thrown with its value", async () => {
  const { client, sleeps } = scripted([reply(429, conjureError("IngestQuotaExceeded", "CUSTOM_CLIENT"), { "Retry-After": "40000" })]);
  await assert.rejects(client.ingest([]), (e: unknown) => e instanceof PlatformApiError && e.retryAfter === 40000);
  assert.deepEqual(sleeps, []);
});

test("network failures back off and give up after maxRetries", async () => {
  const boom = () => new Error("ECONNRESET");
  const { client, calls, sleeps } = scripted([boom(), boom(), boom(), boom()]);
  await assert.rejects(client.eraseSubject("cid_1"), /ECONNRESET/);
  assert.equal(calls.length, 4);
  assert.deepEqual(sleeps, [500, 1000, 2000]);
});

test("a non-JSON error body keeps the HTTP status", async () => {
  const { client } = scripted([reply(502, "<html>Bad gateway</html>")]);
  await assert.rejects(client.searchEvents({ tenant: "acme", from: "a", to: "b" }), (e: unknown) =>
    e instanceof PlatformApiError && e.status === 502 && e.errorName === "HTTP:502");
});

test("searchAllEvents follows page tokens", async () => {
  const hit = (id: string) => ({ eventId: id, product: "spectre", eventType: "t", occurredAt: "x", payload: {} });
  const { client, calls } = scripted([
    reply(200, { hits: [hit("1"), hit("2")], nextPageToken: "p2" }),
    reply(200, { hits: [hit("3")], nextPageToken: null }),
  ]);
  const ids: string[] = [];
  for await (const h of client.searchAllEvents({ tenant: "acme", from: "a", to: "b", pageSize: 2 })) ids.push(h.eventId);
  assert.deepEqual(ids, ["1", "2", "3"]);
  assert.equal(JSON.parse(calls[1].body!).pageToken, "p2");
});

test("documents: put, search and remove", async () => {
  const hit = { collection: "notes", documentId: "n/1", title: "Renewal", snippet: "renewal call", url: null,
    labels: [], updatedAt: "2026-11-27T10:00:00Z" };
  const { client, calls } = scripted([
    reply(200, { collection: "notes", documentId: "n/1" }),
    reply(200, { hits: [hit] }),
    reply(200, { deleted: 1 }),
  ]);
  const doc = { tenant: "acme", title: "Renewal", body: "renewal call", updatedAt: "2026-11-27T10:00:00Z" };
  assert.deepEqual(await client.putDocument("notes", "n/1", doc), { collection: "notes", documentId: "n/1" });
  assert.deepEqual(await client.searchDocuments({ tenant: "acme", text: "renewal", viewer: "cid_1" }), [hit]);
  assert.deepEqual(await client.removeDocument("notes", "n/1", "acme"), { deleted: 1 });
  assert.deepEqual(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`), [
    "PUT /api/v1/documents/collections/notes/documents/n%2F1",
    "POST /api/v1/documents/search",
    "POST /api/v1/documents/collections/notes/documents/n%2F1/remove",
  ]);
  assert.deepEqual(JSON.parse(calls[0].body!), doc);
  assert.deepEqual(JSON.parse(calls[2].body!), { tenant: "acme" });
});

test("quality runs and release budget", async () => {
  const run = { dataset: "spectre.deal", checkedAt: "2026-11-27T10:00:00Z", rows: 10, ok: true,
    metrics: { "completeness:amount": 1 }, results: [] };
  const budget = { dataset: "spectre.deal", totalEpsilon: 10, spentEpsilon: 2.5, remainingEpsilon: 7.5, maxEpsilonPerRelease: 1 };
  const { client, calls } = scripted([reply(200, { runs: [run] }), reply(200, budget)]);
  assert.deepEqual(await client.getQualityRuns("spectre.deal"), [run]);
  assert.deepEqual(await client.getReleaseBudget("spectre.deal"), budget);
  assert.deepEqual(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`), [
    "GET /api/v1/quality/datasets/spectre.deal/runs",
    "GET /api/v1/releases/datasets/spectre.deal/budget",
  ]);
  assert.ok(calls.every((c) => c.body === undefined));
});

test("options are checked", () => {
  assert.throws(() => new PlatformClient({ baseUrl: "http://data-api.example.com", productToken: TOKEN }), /https/);
  assert.throws(() => new PlatformClient({ baseUrl: "https://x.example", productToken: "short" }), /token/);
  assert.doesNotThrow(() => new PlatformClient({ baseUrl: "http://127.0.0.1:8090", productToken: TOKEN }));
});

test("documents: a batch put sends one request with every item", async () => {
  const { client, calls } = scripted([reply(200, { collection: "notes", stored: 2, created: 1 })]);
  const items = [
    { documentId: "a", tenant: "acme", title: "A", body: "", updatedAt: "2026-11-27T10:00:00Z" },
    { documentId: "b", tenant: "acme", title: "B", body: "", updatedAt: "2026-11-27T10:00:00Z",
      expiresAt: "2027-11-27T10:00:00Z" },
  ];
  assert.deepEqual(await client.putDocuments("notes", items), { collection: "notes", stored: 2, created: 1 });
  assert.equal(calls.length, 1);
  assert.equal(`${calls[0].method} ${new URL(calls[0].url).pathname}`, "POST /api/v1/documents/collections/notes/batch");
  assert.deepEqual(JSON.parse(calls[0].body!), { documents: items });
});

test("every client path is an endpoint declared in conjure/platform.yml", () => {
  const yml = readFileSync(new URL("../../../infra/data-platform/conjure/platform.yml", import.meta.url), "utf8");
  const declared = new Set<string>();
  let base = "";
  for (const line of yml.split(/\r?\n/)) {
    const b = line.match(/^\s+base-path:\s*(\S+)/);
    if (b) base = b[1];
    const h = line.match(/^\s+http:\s*(GET|POST|PUT|DELETE)\s+(\S+)/);
    if (h) declared.add(`${h[1]} ${base}${h[2]}`);
  }
  const src = readFileSync(new URL("./platform-client.ts", import.meta.url), "utf8");
  const used = [...src.matchAll(/this\.call\(\s*"(\w+)",\s*[`"]([^`"]+)[`"]/g)].map(
    ([, method, path]) => `${method} ${path.replace(/\$\{enc\((\w+)(?:\.\w+)?\)\}/g, (_m, v: string) => `{${v === "spec" ? "name" : v}}`)}`,
  );
  assert.ok(used.length >= 13);
  for (const u of used) assert.ok(declared.has(u), `${u} is not declared in platform.yml`);
});

test("works against a real HTTP server", async () => {
  const seen: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization}`);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ deleted: 2 }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = (server.address() as AddressInfo).port;
    const client = new PlatformClient({ baseUrl: `http://127.0.0.1:${port}`, productToken: TOKEN });
    assert.deepEqual(await client.eraseSubject("cid_1"), { deleted: 2 });
    assert.deepEqual(seen, [`POST /api/v1/erasure/subjects Bearer ${TOKEN}`]);
  } finally {
    server.close();
  }
});
