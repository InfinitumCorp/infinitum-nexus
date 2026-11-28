import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { LabyrinthHost, RemoteCidDirectory, serveLabyrinthHost } from "@infinitum/lbrnth";
import type { SqlDatabase } from "@infinitum/lbrnth";
import { harness } from "./test-harness.ts";
import { issuerSessions } from "./issuer-sessions.ts";

const ISSUER = "https://id.example/realms/cumulus";
const DIRECTORY_KEY = "test-directory-key-".padEnd(48, "x");
const MIGRATION = readFileSync(new URL("../../../../supabase/migrations/20261111_lbrnth_store.sql", import.meta.url), "utf8");
const b64u = (v: Uint8Array | string) => Buffer.from(v).toString("base64url");

/**
 * The standalone issuer (InfinitumCorp/cumulus-id) as far as +SPCTR sees it: discovery, its ES256 keys, and userinfo,
 * which vouches for an access token only while its session is live. Tokens carry the claims the real one sends, so
 * they are as long (about 800 characters) as what products will present.
 */
async function fakeIssuer() {
  const { privateKey, publicKey } = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = { ...(await webcrypto.subtle.exportKey("jwk", publicKey)), kid: "k1", alg: "ES256", use: "sig" };
  const live = new Set<string>();
  let userinfoCalls = 0;
  const sign = async (claims: Record<string, unknown>, kid = "k1") => {
    const head = b64u(JSON.stringify({ alg: "ES256", typ: "at+jwt", kid }));
    const body = b64u(JSON.stringify(claims));
    const sig = await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, Buffer.from(`${head}.${body}`));
    return `${head}.${body}.${b64u(new Uint8Array(sig))}`;
  };
  const accessToken = async (cid: string, sid: string, extra: Record<string, unknown> = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const token = await sign({
      iss: ISSUER, sub: cid, cid, aud: "architect", azp: "architect", client_id: "architect", iat: now, exp: now + 3600, auth_time: now,
      jti: b64u(randomBytes(16)), sid, scope: "openid profile email", preferred_username: "ada.lovelace", name: "Ada Lovelace",
      email: "ada.lovelace@cumuluscloud.app", email_verified: true, ...extra,
    });
    live.add(token);
    return token;
  };
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return json(200, {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
        token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
        jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
        userinfo_endpoint: `${ISSUER}/protocol/openid-connect/userinfo`,
      });
    }
    if (url === `${ISSUER}/protocol/openid-connect/certs`) return json(200, { keys: [jwk] });
    if (url === `${ISSUER}/protocol/openid-connect/userinfo`) {
      userinfoCalls++;
      const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
      if (!live.has(token)) return json(401, { error: "invalid_token" });
      return json(200, { sub: JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()).sub });
    }
    return json(404, { error: "not_found" });
  }) as typeof globalThis.fetch;
  return { fetch, sign, accessToken, live, calls: () => userinfoCalls };
}

const SECRET = randomBytes(32);

test("the Labyrinth directory accepts the standalone issuer's access tokens in client mode", async () => {
  const issuer = await fakeIssuer();
  const h = await harness({ oidcClient: { issuer: ISSUER, clientId: "spectre", fetch: issuer.fetch }, issuerSessionKey: SECRET, labyrinthDirectoryKeySha256: createHash("sha256").update(DIRECTORY_KEY).digest("hex") });
  try {
    const dir = (body: Record<string, unknown>) => h.call("POST", "/api/id/labyrinth-directory", body, undefined, { "x-cid-directory-key": DIRECTORY_KEY });
    const account = await h.suite.cid.createAccount({ username: "lab-ada" });
    const org = await h.suite.cid.createOrganization("Ada's lab", account.cid);
    await h.suite.cid.grant(account.cid, "LBRNTH", ["repo:read", "repo:write"]);
    const token = await issuer.accessToken(account.cid, "issuer-session-1");
    assert.ok(token.length > 512, `a real access token is long (${token.length})`);

    const who = await dir({ op: "resolve", token });
    assert.equal(who.status, 200, JSON.stringify(who.body));
    assert.equal(who.body.cid, account.cid);
    assert.match(who.body.sessionId, /^issuer\.\d{10}\./);
    assert.equal(who.body.organization.id, org.id);
    assert.deepEqual(who.body.scopes, ["repo:read", "repo:write"]);
    assert.equal((await dir({ op: "session", cid: account.cid, sessionId: who.body.sessionId })).body.active, true);

    // Only ids this +SPCTR made, for that cid, count: no forging with just the directory key.
    const [, exp, tag] = (who.body.sessionId as string).split(".");
    const forged = [
      `issuer.${exp}.${tag}.${"A".repeat(43)}`,
      `issuer.99999999999.AAAAAAAAAAAAAAAA.${"A".repeat(43)}`,
      issuerSessions(randomBytes(32)).id(account.cid, "issuer-session-1", Number(exp)),
      issuerSessions(SECRET).id(account.cid, "s", Math.floor(Date.now() / 1000) + 7 * 24 * 3600), // too far ahead
      issuerSessions(SECRET).id(account.cid, "s", Math.floor(Date.now() / 1000) - 5), // expired
    ];
    for (const sessionId of forged) assert.equal((await dir({ op: "session", cid: account.cid, sessionId })).body.active, false, sessionId);
    const other = await h.suite.cid.createAccount({ username: "lab-eve" });
    assert.equal((await dir({ op: "session", cid: other.cid, sessionId: who.body.sessionId })).body.active, false, "bound to its cid");

    // Not vouched for (signed out, made up, another issuer): refused, and junk never reaches the issuer.
    const before = issuer.calls();
    const signedOut = await issuer.accessToken(account.cid, "issuer-session-2");
    issuer.live.delete(signedOut);
    assert.equal((await dir({ op: "resolve", token: signedOut })).status, 401);
    assert.equal(issuer.calls(), before + 1);
    const madeUp = `${b64u(JSON.stringify({ alg: "ES256", typ: "at+jwt", kid: "k1" }))}.${b64u(JSON.stringify({ iss: ISSUER, sub: account.cid, exp: Math.floor(Date.now() / 1000) + 600, sid: "x" }))}.${b64u(randomBytes(64))}`;
    assert.equal((await dir({ op: "resolve", token: madeUp })).status, 401);
    assert.equal((await dir({ op: "resolve", token: madeUp })).status, 401);
    assert.equal(issuer.calls(), before + 1, "a bad signature is refused here, without asking the issuer");
    assert.equal((await dir({ op: "resolve", token: await issuer.accessToken(account.cid, "s3", { iss: "https://evil.example" }) })).status, 401);

    // In client mode +SPCTR mints no Cumulus ID codes or tokens of its own: the issuer is the only one.
    for (const [method, path] of [["GET", "/api/id/authorize?client_id=veil&redirect_uri=https%3A%2F%2Finfinitumveil.app%2Fcb&code_challenge=x"], ["POST", "/api/id/token"], ["GET", "/api/id/userinfo"], ["GET", "/api/id/redeem"], ["GET", "/api/keys/a%40cumuluscloud.app"]] as const) {
      assert.equal((await h.call(method, path, method === "POST" ? {} : undefined)).status, 404, `${method} ${path}`);
    }
    // A token the person gave another kind of client never opens their Labyrinth: a third-party consent app the
    // issuer knows (academy), Nøde (hosted elsewhere, consent), or a tool on their own computer (loopback).
    for (const client of ["academy", "node", "1mind", "conjure"]) {
      const other = await issuer.accessToken(account.cid, `s-${client}`, { aud: client, azp: client, client_id: client });
      assert.equal((await dir({ op: "resolve", token: other })).status, 401, client);
    }
    // A product token +SPCTR itself minted before the cut-over (an opaque device-handoff session) no longer opens
    // Labyrinth in client mode; the person's own +SPCTR session still does.
    const { createHash: sha } = await import("node:crypto");
    const verifier = "v".repeat(43);
    const { code } = await h.suite.cid.grantDeviceHandoff(account.cid, sha("sha256").update(verifier).digest("base64url"), "architect");
    const handoff = await h.suite.cid.redeemDeviceHandoff(code, verifier, "test");
    assert.equal((await dir({ op: "resolve", token: handoff.token })).status, 401, "old product token");
    // A person known only to the new issuer: no organization or scopes, and can't create either here.
    const stranger = await issuer.accessToken("cid_only_at_the_new_issuer", "s4");
    const s = await dir({ op: "resolve", token: stranger });
    assert.equal(s.status, 200);
    assert.equal(s.body.organization, null);
    assert.deepEqual(s.body.scopes, []);
    assert.equal((await dir({ op: "organization", token: stranger, name: "Ghost org" })).status, 403);
    assert.equal((await dir({ op: "consent", token: stranger, scopes: ["repo:read"] })).status, 403);
  } finally {
    await h.close();
  }
});

test("end to end: a product's real-length issuer token works with Labyrinth, and so does a repository bearer from it", async () => {
  const issuer = await fakeIssuer();
  const pg = new PGlite();
  await pg.exec("create role anon; create role authenticated;");
  await pg.exec(MIGRATION);
  const db: SqlDatabase = {
    query: (text, params) => pg.query(text, params) as never,
    transaction: (fn) => pg.transaction((tx) => fn({ query: (text, params) => tx.query(text, params) as never })),
  };
  let host: LabyrinthHost | undefined;
  const hostServer = createServer((req, res) => {
    if (req.url === "/api/labyrinth") void serveLabyrinthHost(req, res, host);
    else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((r) => hostServer.listen(0, "127.0.0.1", r));
  const endpoint = `http://127.0.0.1:${(hostServer.address() as AddressInfo).port}/api/labyrinth`;
  const h = await harness({ oidcClient: { issuer: ISSUER, clientId: "spectre", fetch: issuer.fetch }, issuerSessionKey: SECRET, labyrinthEndpoint: endpoint, labyrinthDirectoryKeySha256: createHash("sha256").update(DIRECTORY_KEY).digest("hex") });
  try {
    host = new LabyrinthHost({ db, masterKey: new Uint8Array(32).fill(3), directory: new RemoteCidDirectory(`${h.base}/api/id/labyrinth-directory`, DIRECTORY_KEY), entitledOrgs: () => [] });
    const account = await h.suite.cid.createAccount({ username: "lab-grace" });
    const org = await h.suite.cid.createOrganization("Grace's lab", account.cid);
    await h.suite.cid.grant(account.cid, "LBRNTH", ["repo:read", "repo:write", "repo:admin"]);
    await pg.query("insert into lbrnth.entitlements (org_id, plan, source) values ($1, 'client', 'operator')", [org.id]);
    const token = await issuer.accessToken(account.cid, "grace-session");
    const call = (body: Record<string, unknown>, bearer: string) =>
      fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", "x-labyrinth": "1", authorization: `Bearer ${bearer}` }, body: JSON.stringify({ product: "architect", ...body }) })
        .then(async (r) => ({ status: r.status, body: await r.json() }));

    const session = await call({ action: "session" }, token);
    assert.equal(session.status, 200, JSON.stringify(session.body));
    assert.equal(session.body.cid, account.cid);
    assert.equal((await call({ action: "provision" }, token)).status, 200);
    const repoToken = (await call({ action: "token" }, token)).body.token as string;
    assert.match(repoToken, /^lbrnth_/);
    const repo = await call({ action: "create", name: "from-issuer-token" }, repoToken);
    assert.equal(repo.status, 200, JSON.stringify(repo.body));
    assert.equal((await call({ action: "list" }, repoToken)).status, 200);
  } finally {
    await h.close();
    await new Promise<void>((r) => hostServer.close(() => r()));
  }
});

test("without client mode, or without a key, issuer. session ids are never live", async () => {
  for (const opts of [{}, { issuerSessionKey: null, oidcClient: { issuer: ISSUER, clientId: "spectre", fetch: (await fakeIssuer()).fetch } }]) {
    const h = await harness({ ...opts, labyrinthDirectoryKeySha256: createHash("sha256").update(DIRECTORY_KEY).digest("hex") });
    try {
      const account = await h.suite.cid.createAccount({ username: "lab-bob" });
      const sessionId = issuerSessions(SECRET).id(account.cid, "s", Math.floor(Date.now() / 1000) + 600);
      const r = await h.call("POST", "/api/id/labyrinth-directory", { op: "session", cid: account.cid, sessionId }, undefined, { "x-cid-directory-key": DIRECTORY_KEY });
      assert.equal(r.status, 200);
      assert.equal(r.body.active, false);
    } finally {
      await h.close();
    }
  }
});

test("the issuer's yes for an access token is remembered for at most 30 seconds", async () => {
  const { createOidcClient } = await import("./cid-oidc-client.ts");
  const issuer = await fakeIssuer();
  let clock = Date.now();
  const client = createOidcClient({ issuer: ISSUER, clientId: "spectre", fetch: issuer.fetch, now: () => new Date(clock) });
  const token = await issuer.accessToken("cid_1", "s");
  assert.equal((await client.accessToken(token))?.cid, "cid_1");
  issuer.live.delete(token); // signed out at the issuer
  assert.equal((await client.accessToken(token))?.cid, "cid_1");
  assert.equal(issuer.calls(), 1);
  clock += 31_000;
  assert.equal(await client.accessToken(token), null);
  assert.equal(issuer.calls(), 2);
});

test("a key rotation is picked up within seconds, even while someone sends tokens with made-up key ids", async () => {
  const { createOidcClient } = await import("./cid-oidc-client.ts");
  const issuer = await fakeIssuer();
  let jwksCalls = 0;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input instanceof Request ? input.url : input).endsWith("/certs")) jwksCalls++;
    return issuer.fetch(input, init);
  }) as typeof globalThis.fetch;
  const client = createOidcClient({ issuer: ISSUER, clientId: "spectre", fetch });
  assert.ok(await client.accessToken(await issuer.accessToken("cid_r", "s1")));
  // A burst of junk kids: at most one refetch.
  await Promise.all([1, 2, 3, 4, 5].map(async (i) => client.accessToken(await issuer.sign({ iss: ISSUER, sub: "cid_r", exp: Math.floor(Date.now() / 1000) + 600, sid: `j${i}` }, `junk-${i}`))));
  assert.ok(jwksCalls <= 2, `jwks fetched ${jwksCalls} times`);
  // A token signed with a key the issuer hasn't published yet: refused now, but not remembered, so once the
  // issuer publishes it and a few seconds pass it is accepted.
  const early = await issuer.accessToken("cid_r", "s2");
  const rotated = early.replace(/^[^.]+/, Buffer.from(JSON.stringify({ alg: "ES256", typ: "at+jwt", kid: "k2" })).toString("base64url"));
  assert.equal(await client.accessToken(rotated), null);
  await new Promise((r) => setTimeout(r, 5100));
  assert.equal(await client.accessToken(rotated), null, "k2 still isn't published: refused, never cached");
  assert.ok(await client.accessToken(await issuer.accessToken("cid_r", "s3")), "the published key keeps working");
});
