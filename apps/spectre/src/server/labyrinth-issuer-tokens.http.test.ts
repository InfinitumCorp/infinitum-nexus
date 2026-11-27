import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { harness } from "./test-harness.ts";

const ISSUER = "https://id.example/realms/cumulus";
const DIRECTORY_KEY = "test-directory-key-".padEnd(48, "x");
const b64u = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
/** An access token as the standalone issuer mints it; only the fake userinfo below decides whether it is good. */
const accessToken = (claims: Record<string, unknown>) => `${b64u({ alg: "ES256", typ: "at+jwt" })}.${b64u(claims)}.c2ln`;

/**
 * After the cut-over products hold the standalone issuer's access tokens (InfinitumCorp/cumulus-id). Labyrinth's
 * directory accepts them in client mode: the issuer's userinfo vouches for the token and its live session, and the
 * organization, LBRNTH scopes and entitlement still come from +SPCTR's own store, by cid.
 */
test("the Labyrinth directory accepts the standalone issuer's access tokens in client mode", async () => {
  const live = new Set<string>();
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
    if (url === `${ISSUER}/protocol/openid-connect/userinfo`) {
      const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
      if (!live.has(token)) return json(401, { error: "invalid_token" });
      return json(200, { sub: JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()).sub });
    }
    return json(404, { error: "not_found" });
  }) as typeof globalThis.fetch;

  const h = await harness({ oidcClient: { issuer: ISSUER, clientId: "spectre", fetch }, labyrinthDirectoryKeySha256: createHash("sha256").update(DIRECTORY_KEY).digest("hex") });
  try {
    const dir = (body: Record<string, unknown>) => h.call("POST", "/api/id/labyrinth-directory", body, undefined, { "x-cid-directory-key": DIRECTORY_KEY });
    const account = await h.suite.cid.createAccount({ username: "lab-ada" });
    const org = await h.suite.cid.createOrganization("Ada's lab", account.cid);
    await h.suite.cid.grant(account.cid, "LBRNTH", ["repo:read", "repo:write"]);
    const exp = Math.floor(Date.now() / 1000) + 600;
    const token = accessToken({ iss: ISSUER, sub: account.cid, aud: "architect", exp, sid: "issuer-session-1" });
    live.add(token);

    const who = await dir({ op: "resolve", token });
    assert.equal(who.status, 200, JSON.stringify(who.body));
    assert.equal(who.body.cid, account.cid);
    assert.match(who.body.sessionId, new RegExp(`^issuer\\.${exp}\\.`));
    assert.equal(who.body.organization.id, org.id);
    assert.deepEqual(who.body.scopes, ["repo:read", "repo:write"]);
    // Repository bearers minted from it check that session: live until the token's own expiry.
    assert.equal((await dir({ op: "session", cid: account.cid, sessionId: who.body.sessionId })).body.active, true);
    assert.equal((await dir({ op: "session", cid: account.cid, sessionId: `issuer.${Math.floor(Date.now() / 1000) - 5}.abcdefghijkl` })).body.active, false);

    // The issuer refuses a token it doesn't vouch for (signed out, expired, forged): so does the directory. (A yes is
    // remembered for 30 seconds, so a token signed out just now still resolves until then.)
    const fresh = accessToken({ iss: ISSUER, sub: account.cid, aud: "architect", exp, sid: "issuer-session-2" });
    assert.equal((await dir({ op: "resolve", token: fresh })).status, 401);
    // Another issuer's token is never sent to this one.
    const other = accessToken({ iss: "https://evil.example", sub: account.cid, exp, sid: "s" });
    live.add(other);
    assert.equal((await dir({ op: "resolve", token: other })).status, 401);
    // A person who exists only at the new issuer: no organization, no scopes (no entitlement to borrow).
    const stranger = accessToken({ iss: ISSUER, sub: "cid_only_at_the_new_issuer", exp, sid: "s2" });
    live.add(stranger);
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

test("without client mode, issuer. session ids are never live", async () => {
  const h = await harness({ labyrinthDirectoryKeySha256: createHash("sha256").update(DIRECTORY_KEY).digest("hex") });
  try {
    const account = await h.suite.cid.createAccount({ username: "lab-bob" });
    const r = await h.call("POST", "/api/id/labyrinth-directory", { op: "session", cid: account.cid, sessionId: `issuer.${Math.floor(Date.now() / 1000) + 600}.abcdefghijkl` }, undefined, { "x-cid-directory-key": DIRECTORY_KEY });
    assert.equal(r.status, 200);
    assert.equal(r.body.active, false);
  } finally {
    await h.close();
  }
});

test("the issuer's yes for an access token is remembered for at most 30 seconds", async () => {
  const { createOidcClient } = await import("./cid-oidc-client.ts");
  let clock = Date.now();
  let vouch = true;
  let asked = 0;
  const fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/.well-known/openid-configuration")) {
      return Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/a`, token_endpoint: `${ISSUER}/t`, jwks_uri: `${ISSUER}/k`, userinfo_endpoint: `${ISSUER}/u` });
    }
    asked++;
    return vouch ? Response.json({ sub: "cid_1" }) : Response.json({ error: "invalid_token" }, { status: 401 });
  }) as typeof globalThis.fetch;
  const client = createOidcClient({ issuer: ISSUER, clientId: "spectre", fetch, now: () => new Date(clock) });
  const token = accessToken({ iss: ISSUER, sub: "cid_1", exp: Math.floor(clock / 1000) + 600, sid: "s" });
  assert.equal((await client.accessToken(token))?.cid, "cid_1");
  vouch = false; // signed out at the issuer
  assert.equal((await client.accessToken(token))?.cid, "cid_1");
  assert.equal(asked, 1);
  clock += 31_000;
  assert.equal(await client.accessToken(token), null);
  assert.equal(asked, 2);
});
