import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID, webcrypto } from "node:crypto";
import { harness } from "./test-harness.ts";
import { oidcClientFromEnv, DEFAULT_CID_ISSUER } from "./cid-oidc-client.ts";

/**
 * +SPCTR as an OpenID Connect client of the standalone Cumulus://ID issuer, against a fake
 * issuer (WebCrypto ES256 key; discovery, JWKS and token endpoint served through an injected fetch).
 */

const ISSUER = "https://id.test/realms/cumulus";
const CLIENT_ID = "spectre";
const REDIRECT = "http://localhost/api/auth/callback";
const b64u = (b: ArrayBuffer | Uint8Array | string) => Buffer.from(typeof b === "string" ? b : new Uint8Array(b)).toString("base64url");

interface Pending { challenge: string; nonce: string; redirectUri: string; claims: Record<string, unknown> }

async function fakeIssuer() {
  const { privateKey, publicKey } = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const kid = "test-key-1";
  const jwk = { ...(await webcrypto.subtle.exportKey("jwk", publicKey)), kid, alg: "ES256", use: "sig" };
  const codes = new Map<string, Pending>();
  const calls: { url: string; body?: string; contentType?: string }[] = [];

  const sign = async (claims: Record<string, unknown>) => {
    const head = b64u(JSON.stringify({ alg: "ES256", typ: "JWT", kid }));
    const body = b64u(JSON.stringify(claims));
    // WebCrypto ECDSA signatures are raw r||s, which is what JWS ES256 uses.
    const sig = await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, Buffer.from(`${head}.${body}`));
    return `${head}.${body}.${b64u(sig)}`;
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined, contentType: new Headers(init?.headers).get("content-type") ?? undefined });
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return json(200, {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
        token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
        jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
        end_session_endpoint: `${ISSUER}/protocol/openid-connect/logout`,
        revocation_endpoint: `${ISSUER}/protocol/openid-connect/revoke`,
        id_token_signing_alg_values_supported: ["ES256"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url === `${ISSUER}/protocol/openid-connect/certs`) return json(200, { keys: [jwk] });
    if (url === `${ISSUER}/protocol/openid-connect/token` && init?.method === "POST") {
      const form = new URLSearchParams(String(init.body));
      const pending = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? ""); // single use, like the real issuer
      if (!pending) return json(400, { error: "invalid_grant" });
      const s256 = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
      if (form.get("grant_type") !== "authorization_code" || form.get("client_id") !== CLIENT_ID || form.has("client_secret")
        || s256 !== pending.challenge || form.get("redirect_uri") !== pending.redirectUri) {
        return json(400, { error: "invalid_grant" });
      }
      const now = Math.floor(Date.now() / 1000);
      const idToken = await sign({ iss: ISSUER, aud: CLIENT_ID, iat: now, exp: now + 300, auth_time: now, nonce: pending.nonce, sid: "sid-1", amr: ["hwk"], idp: "passkey", ...pending.claims });
      return json(200, { access_token: "at", token_type: "Bearer", expires_in: 3600, id_token: idToken });
    }
    return json(404, { error: "not_found" });
  }) as typeof globalThis.fetch;

  /** The issuer's /auth page: the person signs in, and the browser is sent back with a code. */
  const authorize = (location: string, claims: Record<string, unknown>) => {
    const u = new URL(location);
    assert.equal(u.origin + u.pathname, `${ISSUER}/protocol/openid-connect/auth`);
    const q = u.searchParams;
    assert.equal(q.get("response_type"), "code");
    assert.equal(q.get("client_id"), CLIENT_ID);
    assert.equal(q.get("code_challenge_method"), "S256");
    assert.match(q.get("code_challenge") ?? "", /^[A-Za-z0-9_-]{43}$/);
    assert.ok((q.get("state") ?? "").length >= 32 && (q.get("nonce") ?? "").length >= 32);
    assert.ok((q.get("scope") ?? "").split(" ").includes("openid"));
    const code = randomUUID();
    codes.set(code, { challenge: q.get("code_challenge")!, nonce: q.get("nonce")!, redirectUri: q.get("redirect_uri")!, claims });
    return { code, state: q.get("state")!, query: q };
  };

  return { fetch, authorize, calls, tokenCalls: () => calls.filter((c) => c.url.endsWith("/token")).length };
}

const person = (overrides: Record<string, unknown> = {}) => {
  const cid = `cid_${randomUUID()}`;
  return { sub: cid, cid, preferred_username: "grace", username: "grace", name: "Grace Hopper", handle: "@grace.veil", email: "grace@cumuluscloud.app", email_verified: true, ...overrides };
};

async function oidcHarness() {
  const issuer = await fakeIssuer();
  const h = await harness({ oidcClient: { issuer: ISSUER, clientId: CLIENT_ID, fetch: issuer.fetch } });
  const get = (path: string, cookie?: string) => fetch(h.base + path, { redirect: "manual", headers: cookie ? { cookie } : {} });
  /** /api/auth/login → issuer → /api/auth/callback. */
  const signIn = async (claims: Record<string, unknown>, opts: { prompt?: string } = {}) => {
    const start = await get(`/api/auth/login${opts.prompt ? `?prompt=${opts.prompt}` : ""}`);
    assert.equal(start.status, 302);
    const setCookie = start.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /^spctr_oidc=[^;]+; HttpOnly; Path=\/api\/auth; SameSite=Lax; Max-Age=600/);
    const stateCookie = setCookie.split(";")[0]!;
    const auth = issuer.authorize(start.headers.get("location")!, claims);
    assert.equal(auth.query.get("redirect_uri"), REDIRECT);
    const callbackPath = `/api/auth/callback?code=${encodeURIComponent(auth.code)}&state=${encodeURIComponent(auth.state)}`;
    const back = await get(callbackPath, stateCookie);
    const session = (back.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("spctr_session="));
    return { back, location: back.headers.get("location") ?? "", cookie: session?.split(";")[0], stateCookie, callbackPath, auth };
  };
  return { h, issuer, get, signIn };
}

const isSigninError = (location: string) => location.startsWith("/#/signin-error/");

test("OIDC client mode: sign-in with PKCE, state and nonce creates a +SPCTR session keyed by sub", async () => {
  const { h, issuer, signIn } = await oidcHarness();
  try {
    const grace = person();
    const r = await signIn(grace);
    assert.equal(r.back.status, 302);
    assert.equal(r.location, "/#/today");
    assert.ok(r.cookie, "session cookie set");
    // The one-time state cookie is cleared on the way back.
    assert.ok((r.back.headers.getSetCookie?.() ?? []).some((c) => c.startsWith("spctr_oidc=;") && c.includes("Max-Age=0")));

    // Token request: form-encoded, public client (client_id, no secret), PKCE verifier.
    const tokenCall = issuer.calls.find((c) => c.url.endsWith("/token"))!;
    assert.equal(tokenCall.contentType, "application/x-www-form-urlencoded");
    const form = new URLSearchParams(tokenCall.body);
    assert.equal(form.get("client_id"), CLIENT_ID);
    assert.equal(form.get("client_secret"), null);
    assert.ok(form.get("code_verifier"));

    // The local account is keyed by sub, created from the claims; the CRM works with the grant.
    const me = await h.call("GET", "/api/me", undefined, r.cookie);
    assert.equal(me.status, 200);
    assert.equal(me.body.cid, grace.sub);
    assert.equal(me.body.username, "grace");
    assert.equal(me.body.mailAddress, "grace@cumuluscloud.app");
    assert.equal(me.body.handle, "@grace.veil");
    assert.equal(me.body.workspace, grace.sub);
    assert.ok(h.suite.cid.can(grace.sub, "spectre", "crm:write"));
    const created = await h.call("POST", "/api/companies", { name: "Remington Rand" }, r.cookie);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const companies = (await h.call("GET", "/api/companies", undefined, r.cookie)).body;
    assert.deepEqual(companies.map((c: { name: string }) => c.name), ["Remington Rand"]);

    // Security settings live at the issuer.
    const ids = await h.call("GET", "/api/me/identities", undefined, r.cookie);
    assert.equal(ids.body.manageAt, "https://id.test/account");
    assert.deepEqual(ids.body.linked, []);
    assert.equal((await h.call("GET", "/api/auth/mode")).body.mode, "oidc");

    // Signing in again reuses the same account and CRM workspace.
    const again = await signIn(grace);
    assert.equal(again.location, "/#/today");
    assert.equal((await h.call("GET", "/api/me", undefined, again.cookie)).body.cid, grace.sub);
    assert.equal([...h.suite.cid.store.accounts.values()].filter((a) => a.username.startsWith("grace")).length, 1);

    // Sign-out ends the local session and hands back the issuer's logout with id_token_hint.
    const out = await h.call("POST", "/api/auth/signout", {}, r.cookie);
    assert.equal(out.status, 200);
    const logout = new URL(out.body.logoutUrl);
    assert.equal(logout.origin + logout.pathname, `${ISSUER}/protocol/openid-connect/logout`);
    assert.equal(logout.searchParams.get("client_id"), CLIENT_ID);
    assert.equal(logout.searchParams.get("post_logout_redirect_uri"), "http://localhost/");
    assert.match(logout.searchParams.get("id_token_hint") ?? "", /^[\w-]+\.[\w-]+\.[\w-]+$/);
    assert.equal((await h.call("GET", "/api/me", undefined, r.cookie)).status, 401);
    // The stored hint is not kept once the session ends.
    for (const s of h.suite.cid.store.sessions.values()) if (s.revokedAt) assert.equal(s.idTokenHint, undefined);
  } finally {
    await h.close();
  }
});

test("OIDC client mode: prompt=create reaches the issuer, and an existing in-process account keeps its cid", async () => {
  const { h, issuer, signIn } = await oidcHarness();
  try {
    const start = await fetch(h.base + "/api/auth/login?prompt=create", { redirect: "manual" });
    assert.equal(new URL(start.headers.get("location")!).searchParams.get("prompt"), "create");
    const other = await fetch(h.base + "/api/auth/login?prompt=bogus", { redirect: "manual" });
    assert.equal(new URL(other.headers.get("location")!).searchParams.get("prompt"), null);

    // Someone who signed up before the cut-over: same cid at the issuer, same username here.
    const before = await h.suite.cid.createAccount({ username: "ada" });
    const r = await signIn(person({ sub: before.cid, cid: before.cid, preferred_username: "ada-renamed", email: "ada@cumuluscloud.app" }), { prompt: "create" });
    assert.equal(r.location, "/#/today");
    const me = await h.call("GET", "/api/me", undefined, r.cookie);
    assert.equal(me.body.cid, before.cid);
    assert.equal(me.body.username, "ada");

    // A username taken locally by another cid gets a free variant instead of colliding.
    const r2 = await signIn(person({ preferred_username: "ada" }));
    const me2 = await h.call("GET", "/api/me", undefined, r2.cookie);
    assert.notEqual(me2.body.cid, before.cid);
    assert.equal(me2.body.username, "ada2");
    assert.ok(issuer.tokenCalls() >= 2);
  } finally {
    await h.close();
  }
});

test("OIDC client mode: organizations follow the issuer's org_id, org_name and org_role", async () => {
  const { h, signIn } = await oidcHarness();
  try {
    const cid = h.suite.cid;
    const orgId = `org_${randomUUID()}`;
    const org = { org_id: orgId, org_name: "Acme Analytics" };

    // A member lands in the organization's workspace, created locally from the claims.
    const grace = person({ ...org, org_role: "member" });
    const g = await signIn(grace);
    const gMe = await h.call("GET", "/api/me", undefined, g.cookie);
    assert.equal(gMe.body.workspace, orgId);
    assert.equal(gMe.body.orgName, "Acme Analytics"); // shown in the account bar
    assert.deepEqual(cid.store.orgs.get(orgId), { id: orgId, name: "Acme Analytics", admins: [], source: "issuer" });
    assert.equal((await cid.organizationMembership(grace.sub))?.admin, false);
    assert.equal((await h.call("POST", "/api/companies", { name: "Shared Co" }, g.cookie)).status, 200);

    // An admin becomes a local admin and shares the same CRM workspace.
    const alan = person({ preferred_username: "alan", email: "alan@cumuluscloud.app", handle: "@alan.veil", ...org, org_role: "admin" });
    const a = await signIn(alan);
    assert.equal((await h.call("GET", "/api/me", undefined, a.cookie)).body.workspace, orgId);
    assert.deepEqual(cid.store.orgs.get(orgId)!.admins, [alan.sub]);
    assert.equal((await cid.organizationMembership(alan.sub))?.admin, true);
    const seen = (await h.call("GET", "/api/companies", undefined, a.cookie)).body.map((c: { name: string }) => c.name);
    assert.deepEqual(seen, ["Shared Co"]);

    // A demotion at the issuer is reflected on the next sign-in, and a rename follows the issuer.
    await signIn({ ...alan, org_name: "Acme Analytics Ltd", org_role: "member" });
    assert.deepEqual(cid.store.orgs.get(orgId)!.admins, []);
    assert.equal((await cid.organizationMembership(alan.sub))?.admin, false);
    assert.equal(cid.store.orgs.get(orgId)!.name, "Acme Analytics Ltd");

    // Removed from the organization at the issuer: back to a personal workspace.
    const solo = await signIn({ ...grace, org_id: undefined, org_name: undefined, org_role: undefined });
    assert.equal((await h.call("GET", "/api/me", undefined, solo.cookie)).body.workspace, grace.sub);
    assert.equal((await cid.getAccount(grace.sub)).orgId, undefined);
  } finally {
    await h.close();
  }
});

test("OIDC client mode: an organization that exists only locally is not cleared by a token without org_id", async () => {
  const { h, signIn } = await oidcHarness();
  try {
    const cid = h.suite.cid;
    const before = await cid.createAccount({ username: "lin" });
    const local = await cid.createOrganization("Local Only Co", before.cid);
    const r = await signIn(person({ sub: before.cid, cid: before.cid, preferred_username: "lin" }));
    assert.equal((await h.call("GET", "/api/me", undefined, r.cookie)).body.workspace, local.id);
    assert.equal((await cid.getAccount(before.cid)).orgId, local.id);
    assert.deepEqual(cid.store.orgs.get(local.id)!.admins, [before.cid]);
    assert.equal(cid.store.orgs.get(local.id)!.source, undefined);

    // Once the issuer reports that same (imported) organization, it follows the issuer.
    await signIn(person({ sub: before.cid, cid: before.cid, org_id: local.id, org_name: "Local Only Co", org_role: "member" }));
    assert.equal(cid.store.orgs.get(local.id)!.source, "issuer");
    assert.deepEqual(cid.store.orgs.get(local.id)!.admins, []);
  } finally {
    await h.close();
  }
});

for (const [name, claims, message] of [
  ["a wrong nonce", { nonce: "not-the-nonce-we-sent" }, "nonce"],
  ["a wrong aud", { aud: "cumulus-mail" }, "aud"],
  ["a wrong iss", { iss: "https://evil.example/realms/cumulus" }, "iss"],
  ["an expired exp", { exp: Math.floor(Date.now() / 1000) - 3600 }, "exp"],
  ["a sub that is not a cid", { sub: "someone-else" }, "sub"],
] as const) {
  test(`OIDC client mode: an ID token with ${name} is refused`, async () => {
    const { h, signIn } = await oidcHarness();
    try {
      const grace = person(name === "a sub that is not a cid" ? { cid: undefined } : {});
      const r = await signIn({ ...grace, ...claims });
      assert.equal(r.back.status, 302);
      assert.ok(isSigninError(r.location), `${message}: ${r.location}`);
      assert.equal(r.cookie, undefined, "no session cookie");
      assert.equal(h.suite.cid.store.accounts.has(grace.sub), false, "no account created");
      assert.equal(h.suite.cid.store.sessions.size, 0);
    } finally {
      await h.close();
    }
  });
}

test("OIDC client mode: a state is single use and bound to the browser that started the sign-in", async () => {
  const { h, issuer, get, signIn } = await oidcHarness();
  try {
    const r = await signIn(person());
    assert.ok(r.cookie);
    const exchanges = issuer.tokenCalls();
    // Replaying the same callback (same state, same cookie) is refused before any code exchange.
    const replay = await get(r.callbackPath, r.stateCookie);
    assert.ok(isSigninError(replay.headers.get("location") ?? ""));
    assert.equal((replay.headers.getSetCookie?.() ?? []).some((c) => c.startsWith("spctr_session=")), false);
    assert.equal(issuer.tokenCalls(), exchanges);

    // A callback without the browser's state cookie (login CSRF) is refused, and burns the state.
    const start = await get("/api/auth/login");
    const auth = issuer.authorize(start.headers.get("location")!, person());
    const path = `/api/auth/callback?code=${auth.code}&state=${auth.state}`;
    const noCookie = await get(path);
    assert.ok(isSigninError(noCookie.headers.get("location") ?? ""));
    const later = await get(path, (start.headers.get("set-cookie") ?? "").split(";")[0]);
    assert.ok(isSigninError(later.headers.get("location") ?? ""));
    // An unknown state, and an error from the issuer.
    assert.ok(isSigninError((await get("/api/auth/callback?code=x&state=unknown", "spctr_oidc=unknown")).headers.get("location") ?? ""));
    const denied = await get("/api/auth/login");
    const deniedState = new URL(denied.headers.get("location")!).searchParams.get("state")!;
    const cancelled = await get(`/api/auth/callback?error=access_denied&state=${deniedState}`, (denied.headers.get("set-cookie") ?? "").split(";")[0]);
    assert.equal(cancelled.headers.get("location"), `/#/signin-error/${encodeURIComponent("Sign-in was cancelled.")}`);
    assert.equal(issuer.tokenCalls(), exchanges);
  } finally {
    await h.close();
  }
});

test("OIDC client mode: passkey, MFA and social sign-in routes answer 404", async () => {
  const { h } = await oidcHarness();
  try {
    for (const [method, path] of [
      ["POST", "/api/auth/signup"], ["POST", "/api/auth/signup/finish"], ["POST", "/api/auth/signin"],
      ["POST", "/api/auth/signin/finish"], ["POST", "/api/auth/mfa"], ["GET", "/api/auth/providers"],
      ["GET", "/api/auth/oauth/google/start"], ["GET", "/api/auth/oauth/google/callback"], ["POST", "/api/auth/oauth/google/callback"],
    ] as const) {
      const res = await h.call(method, path, method === "POST" ? { username: "someone" } : undefined);
      assert.equal(res.status, 404, `${method} ${path}`);
    }
  } finally {
    await h.close();
  }
});

test("default mode is unchanged: in-process passkey sign-in, no OIDC client routes", async () => {
  const h = await harness();
  try {
    for (const path of ["/api/auth/login", "/api/auth/callback?code=x&state=y", "/api/auth/mode"]) {
      assert.equal((await fetch(h.base + path, { redirect: "manual" })).status, 404, path);
    }
    const { cookie, cid } = await h.signUp("linus");
    const me = await h.call("GET", "/api/me", undefined, cookie);
    assert.equal(me.body.cid, cid);
    const ids = await h.call("GET", "/api/me/identities", undefined, cookie);
    assert.equal(ids.body.passkeys, 1);
    assert.equal(ids.body.manageAt, undefined);
    assert.equal((await h.call("GET", "/api/auth/providers")).status, 200);
    // The vendored Cumulus://ID account bar is served from this origin (CSP script-src 'self').
    const bar = await fetch(h.base + "/id/bar.js");
    assert.equal(bar.status, 200);
    assert.match(await bar.text(), /window\.CumulusBar = api/);
    const out = await h.call("POST", "/api/auth/signout", {}, cookie);
    assert.deepEqual(out.body, { ok: true });
  } finally {
    await h.close();
  }
});

test("SPECTRE_AUTH=oidc turns client mode on; CID_ISSUER and CID_CLIENT_ID have defaults", () => {
  assert.equal(oidcClientFromEnv({}), null);
  assert.equal(oidcClientFromEnv({ SPECTRE_AUTH: "cid", CID_ISSUER: "https://x" }), null);
  assert.deepEqual(oidcClientFromEnv({ SPECTRE_AUTH: "oidc" }), { issuer: DEFAULT_CID_ISSUER, clientId: "spectre" });
  assert.equal(DEFAULT_CID_ISSUER, "https://id.cumuluscloud.app/realms/cumulus");
  assert.deepEqual(oidcClientFromEnv({ SPECTRE_AUTH: "OIDC", CID_ISSUER: "https://id.example/realms/cumulus/", CID_CLIENT_ID: "spectre-staging" }), {
    issuer: "https://id.example/realms/cumulus",
    clientId: "spectre-staging",
  });
});
