// © Infinitum Corporation®. All rights reserved.
/**
 * S3-compatible object store (Cloudflare R2, AWS S3, MinIO) using only `fetch` and
 * node:crypto. Requests are signed with AWS Signature Version 4.
 *
 * Supports conditional writes (If-Match / If-None-Match), which R2 and S3 both honour, so
 * table commits from several gateway instances cannot overwrite each other.
 *
 * Credentials come from the environment or a secret manager; never from source.
 */
import { createHash, createHmac } from "node:crypto";
import { checkKey, type ConditionalStore, type ObjectStore, PreconditionFailed } from "./storage.ts";

const sha256 = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const hmac = (k: string | Buffer, s: string) => createHmac("sha256", k).update(s).digest();

/** RFC 3986 encoding as SigV4 requires. */
export function uriEncode(s: string, keepSlash = false): string {
  let out = encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  if (keepSlash) out = out.replace(/%2F/g, "/");
  return out;
}

export interface SignInput {
  method: string;
  host: string;
  /** Already-encoded canonical path, e.g. "/bucket/a/b.json". */
  path: string;
  query: Record<string, string>;
  /** Headers to sign (lower-case names). host, x-amz-date and x-amz-content-sha256 are added. */
  headers: Record<string, string>;
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  /** yyyymmddThhmmssZ */
  amzDate: string;
}

/** Returns the Authorization header value plus the headers that were signed. */
export function signV4(i: SignInput): { authorization: string; headers: Record<string, string> } {
  const headers: Record<string, string> = { ...i.headers, host: i.host, "x-amz-date": i.amzDate, "x-amz-content-sha256": i.payloadHash };
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v).trim().replace(/\s+/g, " ");
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalQuery = Object.keys(i.query)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(i.query[k])}`)
    .join("&");
  const canonical = [i.method, i.path, canonicalQuery, canonicalHeaders, signedHeaders, i.payloadHash].join("\n");
  const date = i.amzDate.slice(0, 8);
  const scope = `${date}/${i.region}/${i.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", i.amzDate, scope, sha256(canonical)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac("AWS4" + i.secretAccessKey, date), i.region), i.service), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(toSign).digest("hex");
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    headers,
  };
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}>;

export interface S3Options {
  /** e.g. https://<account>.r2.cloudflarestorage.com */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** "auto" for R2. */
  region?: string;
  /** Optional key prefix inside the bucket, e.g. "lakehouse/prod". */
  prefix?: string;
  fetch?: FetchLike;
  now?: () => Date;
}

export class S3ObjectStore implements ObjectStore, ConditionalStore {
  private readonly o: Required<Omit<S3Options, "prefix">> & { prefix: string };
  private readonly url: URL;

  constructor(options: S3Options) {
    const url = new URL(options.endpoint);
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("S3 endpoint must use https");
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket)) throw new Error("invalid bucket name");
    this.url = url;
    this.o = {
      region: "auto",
      fetch: fetch as unknown as FetchLike,
      now: () => new Date(),
      ...options,
      prefix: options.prefix ? checkKey(options.prefix).replace(/\/$/, "") + "/" : "",
    };
  }

  private async request(
    method: string,
    key: string | null,
    opts: { query?: Record<string, string>; body?: Uint8Array; headers?: Record<string, string> } = {},
  ) {
    const path = `/${this.o.bucket}` + (key === null ? "" : "/" + uriEncode(this.o.prefix + key, true));
    const amzDate = this.o.now().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const payloadHash = sha256(opts.body ?? new Uint8Array());
    const signed = signV4({
      method,
      host: this.url.host,
      path,
      query: opts.query ?? {},
      headers: opts.headers ?? {},
      payloadHash,
      accessKeyId: this.o.accessKeyId,
      secretAccessKey: this.o.secretAccessKey,
      region: this.o.region,
      service: "s3",
      amzDate,
    });
    const qs = Object.entries(opts.query ?? {})
      .map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`)
      .join("&");
    const { host: _host, ...sendHeaders } = signed.headers;
    return this.o.fetch(`${this.url.origin}${path}${qs ? "?" + qs : ""}`, {
      method,
      headers: { ...sendHeaders, authorization: signed.authorization },
      ...(opts.body ? { body: opts.body } : {}),
    });
  }

  private async fail(op: string, r: { status: number; text(): Promise<string> }): Promise<never> {
    const t = await r.text().catch(() => "");
    const code = /<Code>([^<]+)<\/Code>/.exec(t)?.[1] ?? "";
    throw new Error(`S3 ${op} failed: HTTP ${r.status} ${code}`.trim());
  }

  async getWithEtag(key: string): Promise<{ bytes: Uint8Array; etag: string } | undefined> {
    const r = await this.request("GET", checkKey(key));
    if (r.status === 404) return undefined;
    if (r.status !== 200) return this.fail("GET", r);
    return { bytes: new Uint8Array(await r.arrayBuffer()), etag: r.headers.get("etag") ?? "" };
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    return (await this.getWithEtag(key))?.bytes;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const r = await this.request("PUT", checkKey(key), { body: bytes });
    if (r.status !== 200) return this.fail("PUT", r);
  }

  async putIf(key: string, bytes: Uint8Array, etag: string | null): Promise<void> {
    const headers: Record<string, string> = etag === null ? { "if-none-match": "*" } : { "if-match": etag };
    const r = await this.request("PUT", checkKey(key), { body: bytes, headers });
    if (r.status === 412 || r.status === 409) throw new PreconditionFailed(key);
    if (r.status !== 200) return this.fail("PUT", r);
  }

  async delete(key: string): Promise<void> {
    const r = await this.request("DELETE", checkKey(key));
    if (r.status !== 204 && r.status !== 200 && r.status !== 404) return this.fail("DELETE", r);
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let token: string | undefined;
    do {
      const query: Record<string, string> = { "list-type": "2", prefix: this.o.prefix + prefix, "max-keys": "1000" };
      if (token) query["continuation-token"] = token;
      const r = await this.request("GET", null, { query });
      if (r.status !== 200) return this.fail("LIST", r);
      const xml = await r.text();
      for (const m of xml.matchAll(/<Contents>[\s\S]*?<Key>([^<]+)<\/Key>[\s\S]*?<\/Contents>/g)) {
        out.push(decodeXml(m[1]).slice(this.o.prefix.length));
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? decodeXml(/<NextContinuationToken>([^<]+)</.exec(xml)?.[1] ?? "") : undefined;
    } while (token);
    return out.sort();
  }
}

function decodeXml(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|apos);/g, (_, e: string) => ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" })[e]!);
}
