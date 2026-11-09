/**
 * The SCALVS web app at / and the routes it calls.
 * JWKS is a local keypair. Nothing calls the Cumulus issuer.
 */
import { generateKeyPairSync, sign } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { CUMULUS_ISSUER } from "./cumulus-auth.ts";
import { createScalvsServer } from "./http.ts";

const DISCOVERY = `${CUMULUS_ISSUER}/.well-known/openid-configuration`;
const JWKS = `${CUMULUS_ISSUER}/protocol/openid-connect/certs`;
const NOW = new Date("2026-11-07T17:00:00Z");
const SECONDS = Math.floor(NOW.getTime() / 1000);

function localIssuer() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "ui-test", alg: "RS256", use: "sig" };
  const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = { alg: "RS256", kid: "ui-test" };
  const claims = {
    iss: CUMULUS_ISSUER,
    aud: "scalvs",
    sub: "cid_alex",
    iat: SECONDS,
    nbf: SECONDS - 5,
    exp: SECONDS + 600,
  };
  const body = `${enc(header)}.${enc(claims)}`;
  const token = `${body}.${sign("sha256", Buffer.from(body), privateKey).toString("base64url")}`;
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url === DISCOVERY) return Response.json({ issuer: CUMULUS_ISSUER, jwks_uri: JWKS });
    if (url === JWKS) return Response.json({ keys: [jwk] });
    throw new Error(`refused ${url}`);
  };
  return { token, fetchImpl, calls };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function call(base: string, method: string, path: string, body?: unknown, headers?: Record<string, string>) {
  const res = await fetch(base + path, {
    method,
    headers: {
      connection: "close",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  if (text && !(headers?.accept || "").includes("text/html") && !path.endsWith(".js") && !path.endsWith(".css")) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  return { status: res.status, body: parsed as any, headers: res.headers, text };
}

describe("SCALVS web app", { concurrency: false }, () => {
  const idp = localIssuer();
  const auth = { authorization: `Bearer ${idp.token}` };
  const server = createScalvsServer({ origin: "http://127.0.0.1", fetchImpl: idp.fetchImpl, now: () => NOW });
  let base = "";

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("serves the app, script, and stylesheet without a token", async () => {
    base = await listen(server);
    const page = await call(base, "GET", "/", undefined, { accept: "text/html" });
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match(page.text, /Infinitum Corporation®/);
    assert.match(page.text, /SCALVS\.ai/);
    for (const id of ["token", "sign-in", "agent-form", "team-form", "vault", "evidence"]) {
      assert.match(page.text, new RegExp(`id="${id}"`));
    }

    const script = await call(base, "GET", "/app.js");
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type") ?? "", /javascript/);
    assert.match(script.text, /\/v1\/agents/);
    assert.match(script.text, /\/v1\/teams/);
    assert.match(script.text, /\/v1\/memory/);
    assert.match(script.text, /\/v1\/evidence/);
    assert.match(script.text, /authorization/);

    const css = await call(base, "GET", "/app.css");
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /css/);
    assert.deepEqual(idp.calls, []);
  });

  it("creates agents and teams, runs them, and shows vault and evidence", async () => {
    const created = await call(base, "POST", "/v1/agents", {
      id: "researcher",
      name: "Researcher",
      role: "Research",
      tools: ["echo"],
    }, auth);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const scribe = await call(base, "POST", "/v1/agents", {
      id: "scribe",
      name: "Scribe",
      role: "Notes",
      tools: ["note"],
    }, auth);
    assert.equal(scribe.status, 201);

    const listed = await call(base, "GET", "/v1/agents", undefined, auth);
    assert.deepEqual(listed.body.map((agent: { id: string }) => agent.id), ["researcher", "scribe"]);

    const duplicate = await call(base, "POST", "/v1/agents", { id: "researcher", name: "Again", role: "Research", tools: ["echo"] }, auth);
    assert.equal(duplicate.status, 409);

    const run = await call(base, "POST", "/v1/agents/run", { ...listed.body[0], prompt: "hello" }, auth);
    assert.equal(run.status, 200, JSON.stringify(run.body));
    assert.equal(run.body.toolCalls[0].tool, "echo");

    const team = await call(base, "POST", "/v1/teams", { id: "desk", name: "Desk", agentIds: ["researcher", "scribe"] }, auth);
    assert.equal(team.status, 201, JSON.stringify(team.body));
    const teams = await call(base, "GET", "/v1/teams", undefined, auth);
    assert.equal(teams.body[0].name, "Desk");

    const teamRun = await call(base, "POST", "/v1/team/run", {
      prompt: "hello",
      agents: listed.body,
    }, auth);
    assert.equal(teamRun.status, 200);
    assert.equal(teamRun.body.length, 2);

    const memory = await call(base, "GET", "/v1/memory/researcher", undefined, auth);
    assert.equal(memory.status, 200);
    assert.ok(memory.body.length >= 1);

    const evidence = await call(base, "POST", "/v1/evidence", { ...listed.body[0], prompt: "hello" }, auth);
    assert.equal(evidence.status, 200, JSON.stringify(evidence.body));
    assert.equal(evidence.body.agentId, "researcher");
    assert.equal(evidence.body.verified, true);

    const anchored = await call(base, "POST", "/v1/memory/persist", { agentId: "researcher", content: "anchored", tags: ["firm"] }, auth);
    assert.match(anchored.body.hash, /^0xfirm_/);

    assert.equal(idp.calls.every((url) => url === DISCOVERY || url === JWKS), true);
  });
});
