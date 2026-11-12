// © Infinitum Corporation®. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { S3ObjectStore, signV4, type FetchLike } from "./s3.ts";
import { MemoryObjectStore, PreconditionFailed } from "./storage.ts";
import { Table } from "./table.ts";
import { defaultCatalog } from "./catalog.ts";
import { ExportRefused, prepareOffer } from "./exchange.ts";
import { MemoryTenancy, PolicyService } from "./policy.ts";
import { PrivacyBudget } from "./privacy.ts";

// AWS's published SigV4 example ("GET Object", S3 docs). These are AWS's documentation
// placeholder credentials, not real ones.
test("SigV4 matches the AWS documented example", () => {
  const { authorization } = signV4({
    method: "GET",
    host: "examplebucket.s3.amazonaws.com",
    path: "/test.txt",
    query: {},
    headers: { range: "bytes=0-9" },
    payloadHash: createHash("sha256").update("").digest("hex"),
    accessKeyId: "AKIAIOSFODNN7" + "EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCY" + "EXAMPLEKEY",
    region: "us-east-1",
    service: "s3",
    amzDate: "20130524T000000Z",
  });
  assert.match(authorization, /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
  assert.match(authorization, /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,/);
});

/** Minimal in-memory S3: path-style objects, ListObjectsV2 with paging, conditional PUT. */
function fakeS3(): { fetch: FetchLike; objects: Map<string, Uint8Array>; seenAuth: string[] } {
  const objects = new Map<string, Uint8Array>();
  const seenAuth: string[] = [];
  const etag = (b: Uint8Array) => `"${createHash("md5").update(b).digest("hex")}"`;
  const res = (status: number, body: string | Uint8Array = "", headers: Record<string, string> = {}) => ({
    status,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    arrayBuffer: async () => (typeof body === "string" ? new TextEncoder().encode(body) : body).slice().buffer as ArrayBuffer,
    text: async () => (typeof body === "string" ? body : new TextDecoder().decode(body)),
  });
  const f: FetchLike = async (url, init) => {
    seenAuth.push(init.headers.authorization);
    const u = new URL(url);
    const [, bucket, ...rest] = u.pathname.split("/");
    assert.equal(bucket, "lake");
    const key = decodeURIComponent(rest.join("/"));
    if (init.method === "GET" && !key) {
      const prefix = u.searchParams.get("prefix") ?? "";
      const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = Number(u.searchParams.get("continuation-token") ?? 0);
      const page = all.slice(start, start + 2); // tiny pages to exercise pagination
      const more = start + 2 < all.length;
      const xml = `<ListBucketResult>${page.map((k) => `<Contents><Key>${k.replace(/&/g, "&amp;")}</Key></Contents>`).join("")}<IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : ""}</ListBucketResult>`;
      return res(200, xml);
    }
    const cur = objects.get(key);
    if (init.method === "GET") return cur ? res(200, cur, { etag: etag(cur) }) : res(404, "<Error><Code>NoSuchKey</Code></Error>");
    if (init.method === "DELETE") {
      objects.delete(key);
      return res(204);
    }
    if (init.method === "PUT") {
      if (init.headers["if-none-match"] === "*" && cur) return res(412);
      if (init.headers["if-match"] && (!cur || etag(cur) !== init.headers["if-match"])) return res(412);
      objects.set(key, new Uint8Array(init.body ?? new Uint8Array()));
      return res(200);
    }
    return res(400);
  };
  return { fetch: f, objects, seenAuth };
}

test("S3 store: get/put/delete/list with prefix, paging and conditional puts", async () => {
  const s3 = fakeS3();
  const store = new S3ObjectStore({
    endpoint: "https://acct.r2.cloudflarestorage.com",
    bucket: "lake",
    prefix: "prod",
    accessKeyId: "test-key-id",
    secretAccessKey: "test-secret-not-real",
    fetch: s3.fetch,
  });
  const enc = new TextEncoder();
  for (const k of ["a/1", "a/2", "a/3", "b/1", "a/x=y.z"]) await store.put(k, enc.encode(k));
  assert.deepEqual([...s3.objects.keys()].sort()[0], "prod/a/1");
  assert.deepEqual(await store.list("a/"), ["a/1", "a/2", "a/3", "a/x=y.z"]);
  assert.equal(new TextDecoder().decode((await store.get("a/x=y.z"))!), "a/x=y.z");
  await store.delete("a/2");
  assert.equal(await store.get("a/2"), undefined);
  const cur = await store.getWithEtag("a/1");
  await store.putIf("a/1", enc.encode("v2"), cur!.etag);
  await assert.rejects(store.putIf("a/1", enc.encode("v3"), cur!.etag), PreconditionFailed);
  await assert.rejects(store.putIf("a/1", enc.encode("v3"), null), PreconditionFailed);
  assert.ok(s3.seenAuth.every((a) => a.startsWith("AWS4-HMAC-SHA256 Credential=test-key-id/")));
  assert.throws(() => new S3ObjectStore({ endpoint: "http://evil.example", bucket: "lake", accessKeyId: "a", secretAccessKey: "b" }));
});

test("concurrent writers on a conditional store never lose a commit", async () => {
  const store = new MemoryObjectStore();
  // Two Table instances = two gateway processes sharing one bucket.
  const a = new Table(store, "raw/c");
  const b = new Table(store, "raw/c");
  const part = () => "product=p/date=2026-01-01";
  await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).append([{ i }], part)));
  assert.deepEqual((await a.scan()).map((r) => r.i).sort((x, y) => Number(x) - Number(y)), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test("Exchange offers are aggregates only and pass every gate", () => {
  const catalog = defaultCatalog();
  catalog.register({
    id: "curated.file_types",
    zone: "curated",
    table: "curated/file_types",
    description: "How many people store each media type.",
    owners: ["data-platform"],
    classification: "internal",
    purposes: ["product_analytics", "exchange_licensing"],
    glossary: {},
    upstream: ["curated.files"],
    transformation_version: "file-types@1.0.0",
    expires_after_days: 90,
    exportable: true,
  });
  const policy = new PolicyService(new MemoryTenancy());
  const put = (t: string, exportAllowed: boolean) =>
    policy.put({ id: `pol_${t}`, tenant_id: t, product: "cumulus-cloud", purposes: ["service_operation", "exchange_licensing"], exportAllowed, sourceRights: "first_party" });
  put("t1", true);
  put("t2", false);
  const rows = Array.from({ length: 60 }, (_, n) => ({ tenant: "t1", person: `sub_${n}`, media: n % 3 ? "application/pdf" : "image/png" }));
  const budget = new PrivacyBudget(1);
  const base = {
    catalog,
    policy,
    budget,
    datasetId: "curated.file_types",
    product: "cumulus-cloud",
    title: "Media types",
    tenantColumn: "tenant",
    personColumn: "person",
    groupColumn: "media",
    groups: ["application/pdf", "image/png", "video/mp4"],
    epsilon: 0.5,
    licenseTerms: "CDAT-commercial-1y",
    priceUsd: 100,
  };
  const offer = prepareOffer({ ...base, rows });
  assert.equal(offer.privacyLevel, "aggregated");
  assert.ok(!JSON.stringify(offer).includes("sub_"), "no person ids in the offer");
  assert.deepEqual(offer.lineage, ["curated.file_types", "curated.files", "normalized.events", "raw.events"]);
  assert.ok(!("video/mp4" in offer.counts), "empty group suppressed");

  assert.throws(() => prepareOffer({ ...base, rows: [...rows, { tenant: "t2", person: "sub_x", media: "image/png" }] }), ExportRefused);
  assert.throws(() => prepareOffer({ ...base, datasetId: "curated.files", rows }), /not marked exportable/);
  assert.throws(() => prepareOffer({ ...base, product: "aether", rows }), /military/);
});
