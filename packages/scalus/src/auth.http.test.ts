/**
 * Cumulus ID authentication for the SCALVS HTTP server.
 * JWKS is a local keypair served by a fake fetch. Nothing calls the issuer.
 */
import { generateKeyPairSync, sign } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { CUMULUS_ISSUER, createCumulusAuth } from "./cumulus-auth.ts";
import { createScalvsServer } from "./http.ts";

const ISSUER = CUMULUS_ISSUER;
const DISCOVERY = `${ISSUER}/.well-known/openid-configuration`;
const JWKS = `${ISSUER}/protocol/openid-connect/certs`;
const NOW = new Date("2026-11-07T16:00:00Z");
const SECONDS = Math.floor(NOW.getTime() / 1000);

function keypair(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
  const issue = (claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid }) => {
    const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const body = `${enc(header)}.${enc(claims)}`;
    return `${body}.${sign("sha256", Buffer.from(body), privateKey).toString("base64url")}`;
  };
  return { jwk, issue, privateKey };
}

const signer = keypair("scalvs-test");
const other = keypair("other");

function claims(overrides: Record<string, unknown> = {}) {
  return {
    iss: ISSUER,
    aud: "scalvs",
    sub: "cid_alex",
    iat: SECONDS,
    nbf: SECONDS - 10,
    exp: SECONDS + 600,
    ...overrides,
  };
}

function mockFetch(keys: unknown[], jwksUri = JWKS) {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, _init) => {
    const url = String(input);
    calls.push(url);
    if (url === DISCOVERY) return Response.json({ issuer: ISSUER, jwks_uri: jwksUri });
    if (url === jwksUri) return Response.json({ keys });
    throw new Error(`refused ${url}`);
  };
  return { fetchImpl, calls };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function call(base: string, method: string, path: string, body?: unknown, headers?: Record<string, string>) {
  const res = await fetch(base + path, {
    method,
    headers: {
      connection: "close",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = text;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  return { status: res.status, body: parsed as any, headers: res.headers, text };
}

describe("Cumulus ID JWT on the SCALVS server", { concurrency: false }, () => {
  const jwks = mockFetch([signer.jwk]);
  const token = signer.issue(claims());
  const auth = { authorization: `Bearer ${token}` };
  const server = createScalvsServer({
    origin: "http://localhost:3020",
    fetchImpl: jwks.fetchImpl,
    now: () => NOW,
  });
  let base = "";

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("starts and leaves GET /health public", async () => {
    base = await listen(server);
    const health = await call(base, "GET", "/health", undefined, { authorization: "Bearer not-a-token" });
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.service, "scalvs");
    assert.deepEqual(jwks.calls, [], "health does not discover JWKS");
  });

  it("returns 401 when the token is missing", async () => {
    for (const [method, path] of [["GET", "/"], ["GET", "/v1/tools"], ["POST", "/v1/agents/run"], ["OPTIONS", "/v1/agents/run"], ["POST", "/health"]] as const) {
      const res = await call(base, method, path, method === "POST" ? {} : undefined);
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.equal(res.body.error, "unauthorized");
      assert.match(res.headers.get("www-authenticate") ?? "", /Bearer realm="scalvs"/);
    }
    assert.deepEqual(jwks.calls, []);
  });

  it("discovers JWKS from the Cumulus issuer and accepts a local signature", async () => {
    const tools = await call(base, "GET", "/v1/tools", undefined, auth);
    assert.equal(tools.status, 200, JSON.stringify(tools.body));
    assert.deepEqual(tools.body.map((tool: { name: string }) => tool.name), ["echo", "search", "note"]);
    assert.deepEqual(jwks.calls, [DISCOVERY, JWKS]);

    const again = await call(base, "GET", "/v1/tools", undefined, auth);
    assert.equal(again.status, 200);
    assert.deepEqual(jwks.calls, [DISCOVERY, JWKS], "keys are reused");

    const page = await call(base, "GET", "/", undefined, { ...auth, accept: "text/html" });
    assert.equal(page.status, 200);
    assert.match(page.text, /SCALVS\.ai/);
  });

  it("rejects a bad signature, the wrong issuer, expiry, nbf, and audience", async () => {
    const cases: Array<[string, string]> = [
      ["malformed", "Bearer aaa.bbb.ccc"],
      ["unsigned", `Bearer ${signer.issue(claims(), { alg: "none", kid: "scalvs-test" })}`],
      ["other key", `Bearer ${other.issue(claims(), { alg: "RS256", kid: "scalvs-test" })}`],
      ["unknown kid", `Bearer ${other.issue(claims())}`],
      ["wrong iss", `Bearer ${signer.issue(claims({ iss: "https://evil.example" }))}`],
      ["expired", `Bearer ${signer.issue(claims({ exp: SECONDS - 1 }))}`],
      ["nbf", `Bearer ${signer.issue(claims({ nbf: SECONDS + 60 }))}`],
      ["audience", `Bearer ${signer.issue(claims({ aud: "other-app" }))}`],
      ["missing exp", `Bearer ${signer.issue(claims({ exp: undefined }))}`],
    ];
    for (const [name, authorization] of cases) {
      const res = await call(base, "GET", "/v1/tools", undefined, { authorization });
      assert.equal(res.status, 401, name);
    }
    const listed = jwks.calls.every((url) => url === DISCOVERY || url === JWKS);
    assert.equal(listed, true);
  });

  it("accepts an audience array and a token without nbf", async () => {
    const arrayAud = await call(base, "GET", "/v1/tools", undefined, { authorization: `Bearer ${signer.issue(claims({ aud: ["account", "scalvs"] }))}` });
    assert.equal(arrayAud.status, 200);
    const noNbf = claims();
    delete (noNbf as { nbf?: number }).nbf;
    const open = await call(base, "GET", "/v1/tools", undefined, { authorization: `Bearer ${signer.issue(noNbf)}` });
    assert.equal(open.status, 200);
  });

  it("runs the existing agent, team, vault, and evidence routes with a token", async () => {
    const run = await call(base, "POST", "/v1/agents/run", {
      id: "researcher",
      name: "Researcher",
      role: "Research",
      prompt: "hello",
      tools: ["echo"],
    }, auth);
    assert.equal(run.status, 200, JSON.stringify(run.body));
    assert.equal(run.body.toolCalls[0].tool, "echo");
    assert.deepEqual(run.body.toolCalls[0].result, { echoed: "hello" });

    const recalled = await call(base, "GET", "/v1/memory/researcher", undefined, auth);
    assert.equal(recalled.body.length, 1);
    const cleared = await call(base, "POST", "/v1/memory/researcher/clear", {}, auth);
    assert.equal(cleared.body.cleared, true);

    const team = await call(base, "POST", "/v1/team/run", {
      prompt: "hello",
      agents: [
        { id: "alpha", name: "Alpha", role: "research", tools: ["echo"] },
        { id: "beta", name: "Beta", role: "notes", tools: ["note"] },
      ],
    }, auth);
    assert.equal(team.body.length, 2);

    const evidence = await call(base, "POST", "/v1/evidence", {
      id: "recorder", name: "Recorder", role: "audit", prompt: "hello", tools: ["echo"],
    }, auth);
    assert.equal(evidence.body.verified, true);

    const saved = await call(base, "POST", "/v1/memory/persist", { agentId: "keeper", content: "anchored", tags: ["firm"] }, auth);
    assert.match(saved.body.hash, /^0xfirm_/);

    const preflight = await call(base, "OPTIONS", "/v1/agents/run", undefined, auth);
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /authorization/);

    const missingPrompt = await call(base, "POST", "/v1/agents/run", { id: "researcher" }, auth);
    assert.equal(missingPrompt.status, 400);
    const llm = await call(base, "POST", "/v1/llm/run", { system: "You are SCALVS.", prompt: "hello", tools: ["echo"] }, auth);
    assert.equal(llm.status, 503);
    const method = await call(base, "POST", "/health", {}, auth);
    assert.equal(method.status, 405);
  });
});

describe("audience configuration and JWKS guards", () => {
  it("uses the configured audience and ignores the default", async () => {
    const jwks = mockFetch([signer.jwk]);
    const server = createScalvsServer({ origin: "http://127.0.0.1", audience: "scalvs-preview", fetchImpl: jwks.fetchImpl, now: () => NOW });
    const base = await listen(server);
    try {
      const wrong = await call(base, "GET", "/v1/tools", undefined, { authorization: `Bearer ${signer.issue(claims())}` });
      assert.equal(wrong.status, 401);
      const right = await call(base, "GET", "/v1/tools", undefined, { authorization: `Bearer ${signer.issue(claims({ aud: "scalvs-preview" }))}` });
      assert.equal(right.status, 200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not fetch a JWKS URL that leaves the issuer", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url === DISCOVERY) return Response.json({ jwks_uri: "https://evil.example/jwks" });
      throw new Error(`refused ${url}`);
    };
    const server = createScalvsServer({ origin: "http://127.0.0.1", fetchImpl, now: () => NOW });
    const base = await listen(server);
    try {
      const res = await call(base, "GET", "/v1/tools", undefined, { authorization: `Bearer ${signer.issue(claims())}` });
      assert.equal(res.status, 401);
      assert.deepEqual(calls, [DISCOVERY]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects an http JWKS URL advertised by discovery", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url === DISCOVERY) return Response.json({ jwks_uri: "http://id.cumuluscloud.app/realms/cumulus/protocol/openid-connect/certs" });
      throw new Error(`refused ${url}`);
    };
    const server = createScalvsServer({ origin: "http://127.0.0.1", fetchImpl, now: () => NOW });
    const base = await listen(server);
    try {
      const res = await call(base, "GET", "/", undefined, { authorization: `Bearer ${signer.issue(claims())}` });
      assert.equal(res.status, 401);
      assert.deepEqual(calls, [DISCOVERY]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("ES256 access tokens", () => {
  it("accepts an ES256 token signed by a key from discovery", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = { ...publicKey.export({ format: "jwk" }), kid: "ec1", alg: "ES256", use: "sig" };
    const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const header = { alg: "ES256", kid: "ec1" };
    const body = `${enc(header)}.${enc(claims())}`;
    const token = `${body}.${sign("sha256", Buffer.from(body), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
    const { fetchImpl } = mockFetch([jwk]);
    const auth = createCumulusAuth({ fetchImpl, now: () => NOW });
    await auth.authenticate(`Bearer ${token}`);
  });
});
