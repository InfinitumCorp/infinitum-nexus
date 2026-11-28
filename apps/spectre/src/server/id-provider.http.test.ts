/**
 * Sign in with Cumulus://ID on the ID host.
 * Google is simulated. Nothing calls a real provider.
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { CidService, signerFromJwk, verifyOidcToken, type SocialProviderId } from "@infinitum/cid";
import { SpectreCRM } from "../core/crm.ts";
import { createApp } from "./app.ts";

const here = dirname(fileURLToPath(import.meta.url));

function oidcKey() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return signerFromJwk({ ...privateKey.export({ format: "jwk" }), kid: "test-oidc" });
}

function fakeProviders() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "idp", alg: "RS256", use: "sig" };
  const users: Record<string, Record<string, unknown>> = {
    google: { sub: "g-111", email: "ada@gmail.example", email_verified: true, name: "Ada" },
  };
  const issuers: Record<string, string> = {
    google: "https://accounts.google.com",
  };
  const hosts: Record<string, SocialProviderId> = {
    "oauth2.googleapis.com": "google",
  };
  const codes = new Map<string, { provider: SocialProviderId; nonce: string; challenge: string; clientId: string }>();
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const idToken = (claims: Record<string, unknown>) => {
    const body = `${enc({ alg: "RS256", kid: "idp" })}.${enc(claims)}`;
    return `${body}.${sign("sha256", Buffer.from(body), privateKey).toString("base64url")}`;
  };
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (/certs|jwks/.test(url.pathname)) return json({ keys: [jwk] });
    const provider = hosts[url.host];
    if (provider && init?.method === "POST") {
      const form = new URLSearchParams(String(init.body));
      const grant = codes.get(form.get("code") ?? "");
      if (!grant || grant.provider !== provider) return json({ error: "invalid_grant" }, 400);
      if (createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") !== grant.challenge) {
        return json({ error: "invalid_grant" }, 400);
      }
      const now = Math.floor(Date.now() / 1000);
      return json({
        access_token: "at",
        id_token: idToken({
          iss: issuers[provider],
          aud: grant.clientId,
          nonce: grant.nonce,
          iat: now,
          exp: now + 600,
          ...users[provider],
        }),
      });
    }
    return json({ error: "not found" }, 404);
  }) as typeof fetch;
  const approve = (authorizeUrl: string, provider: SocialProviderId) => {
    const u = new URL(authorizeUrl);
    const code = `code-${randomBytes(8).toString("hex")}`;
    codes.set(code, {
      provider,
      nonce: u.searchParams.get("nonce") ?? "",
      challenge: u.searchParams.get("code_challenge") ?? "",
      clientId: u.searchParams.get("client_id") ?? "",
    });
    return { code, state: u.searchParams.get("state")! };
  };
  return { fetchImpl, approve };
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

describe("Cumulus://ID product sign-in", () => {
  let server: Server;
  let base: string;
  let cid: CidService;
  const signingKey = oidcKey();
  const fake = fakeProviders();

  before(async () => {
    const signer = generateSigner();
    const ledger = new Ledger(undefined, { authorizedSigners: [signer.publicKey] });
    cid = new CidService({
      ledger, signer, rpId: "id.cumuluscloud.app", origins: ["https://id.cumuluscloud.app"],
      social: {
        providers: {
          google: { clientId: "google-client", clientSecret: "gs" },
        },
        fetchImpl: fake.fetchImpl,
      },
    });
    const crm = new SpectreCRM({ ledger, signer });
    const app = createApp({
      cid, crm, ai: {}, publicDir: join(here, "../../public"), secureCookies: true,
      origin: "https://id.cumuluscloud.app", oidcSigner: signingKey,
    });
    server = app.server();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => new Promise<void>((r) => server.close(() => r())));

  const raw = (path: string, cookie?: string) => fetch(base + path, { redirect: "manual", headers: cookie ? { cookie } : {} });

  async function throughProvider(provider: "google", clientId: string, redirect: string) {
    const { verifier, challenge } = pkce();
    const q = new URLSearchParams({
      client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "st",
    });
    const startAuth = await raw(`/api/id/authorize?${q}`);
    assert.equal(startAuth.status, 302);
    const next = new URL(startAuth.headers.get("location")!, "https://id.cumuluscloud.app").searchParams.get("next");
    assert.ok(next?.startsWith("/api/id/authorize"));

    const start = await raw(`/api/auth/oauth/${provider}/start?next=${encodeURIComponent(next!)}`);
    assert.equal(start.status, 302);
    const providerUrl = start.headers.get("location")!;
    const { code, state } = fake.approve(providerUrl, provider);
    const jar = start.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const cb = await raw(`/api/auth/oauth/${provider}/callback?code=${code}&state=${state}`, jar);
    assert.equal(cb.status, 302, cb.headers.get("location") ?? "");
    const back = cb.headers.get("location")!;
    assert.match(back, /^\/api\/id\/authorize\?/);
    const session = cb.headers.getSetCookie().find((c) => c.startsWith("spctr_session="))!.split(";")[0];
    const product = await raw(back, session);
    assert.equal(product.status, 302);
    const to = new URL(product.headers.get("location")!);
    assert.equal(to.origin + to.pathname, redirect);
    const token = await fetch(base + "/api/id/token", {
      method: "POST",
      headers: { "content-type": "text/plain", origin: new URL(redirect).origin },
      body: JSON.stringify({ code: to.searchParams.get("code"), code_verifier: verifier, client_id: clientId }),
    });
    const body = await token.json() as { access_token: string; id_token: string; profile: { cid: string; email: string } };
    assert.equal(token.status, 200, JSON.stringify(body));
    return body;
  }

  it("issues a cid on the first Google sign-in and reuses it on the second", async () => {
    assert.equal(cid.store.accounts.size, 0);
    const first = await throughProvider("google", "scalvs", "https://scalvs.app/signed-in");
    assert.equal(cid.store.accounts.size, 1);
    const claims = verifyOidcToken(first.id_token, signingKey, { issuer: cid.issuer, now: new Date(), audience: "scalvs" });
    assert.equal(claims.sub, first.profile.cid);
    assert.equal(claims.cid, first.profile.cid);
    assert.equal(claims.idp, "google");
    assert.deepEqual(claims.amr, ["google"]);
    assert.equal(claims.email, "ada@gmail.example");
    assert.equal(claims.email_verified, true);
    assert.equal(typeof claims.username, "string");
    assert.equal(typeof claims.handle, "string");
    const access = verifyOidcToken(first.access_token, signingKey, { issuer: cid.issuer, now: new Date(), audience: "scalvs" });
    assert.equal(access.sub, first.profile.cid);

    const second = await throughProvider("google", "scalvs", "https://scalvs.app/again");
    assert.equal(cid.store.accounts.size, 1);
    const again = verifyOidcToken(second.id_token, signingKey, { issuer: cid.issuer, now: new Date(), audience: "scalvs" });
    assert.equal(again.sub, first.profile.cid);
  });

  it("offers no Amazon Cognito sign-in", async () => {
    const providers = await (await fetch(base + "/api/auth/providers")).text();
    assert.doesNotMatch(providers, /cognito/i);
    const start = await raw("/api/auth/oauth/cognito/start");
    assert.notEqual(start.status, 302);
    assert.equal(start.headers.get("location"), null);
  });

  it("publishes discovery and a public JWKS on the realm issuer", async () => {
    const doc = await (await fetch(base + "/realms/cumulus/.well-known/openid-configuration")).json();
    const root = await (await fetch(base + "/.well-known/openid-configuration")).json();
    assert.equal(doc.issuer, cid.issuer);
    assert.equal(doc.issuer, "https://id.cumuluscloud.app/realms/cumulus");
    assert.deepEqual(root, doc);
    assert.equal(doc.jwks_uri, `${cid.issuer}/protocol/openid-connect/certs`);
    assert.equal(doc.end_session_endpoint, `${cid.issuer}/protocol/openid-connect/logout`);
    assert.equal(doc.revocation_endpoint, `${cid.issuer}/protocol/openid-connect/revoke`);
    const jwks = await (await fetch(base + "/realms/cumulus/protocol/openid-connect/certs")).text();
    assert.match(jwks, /"kid":"test-oidc"/);
    assert.doesNotMatch(jwks, /"d"/);
    const keys = JSON.parse(jwks).keys;
    assert.equal(keys[0].kty, "EC");
    assert.equal(keys[0].d, undefined);
  });

  it("publishes and reads a public key only for the token's own address", async () => {
    const body = await throughProvider("google", "scalvs", "https://scalvs.app/keys");
    const pub = "-----BEGIN PGP PUBLIC KEY BLOCK-----\nxsBNB\n-----END PGP PUBLIC KEY BLOCK-----\n";
    const priv = "-----BEGIN PGP PRIVATE KEY BLOCK-----\nsecret\n-----END PGP PRIVATE KEY BLOCK-----\n";
    const email = "ada@gmail.example";
    const put = await fetch(base + `/api/keys/${encodeURIComponent(email)}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${body.access_token}`, "content-type": "application/pgp-keys" },
      body: pub,
    });
    assert.equal(put.status, 204);
    const got = await fetch(base + `/api/keys/${encodeURIComponent("Ada@gmail.example")}`, { redirect: "manual" });
    assert.equal(got.status, 200);
    assert.match(got.headers.get("content-type") ?? "", /application\/pgp-keys/);
    assert.equal(await got.text(), pub.trim());
    const missing = await fetch(base + "/api/keys/missing@example.com", { redirect: "manual" });
    assert.equal(missing.status, 404);
    const other = await fetch(base + "/api/keys/other@example.com", {
      method: "PUT",
      headers: { authorization: `Bearer ${body.access_token}`, "content-type": "application/pgp-keys" },
      body: pub,
    });
    assert.equal(other.status, 403);
    const secret = await fetch(base + `/api/keys/${encodeURIComponent(email)}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${body.access_token}`, "content-type": "application/pgp-keys" },
      body: priv,
    });
    assert.equal(secret.status, 400);
    const still = await fetch(base + `/api/keys/${encodeURIComponent(email)}`);
    assert.equal(await still.text(), pub.trim());
    assert.equal(still.headers.get("location"), null);
  });

  it("logout and revocation end the session the token named", async () => {
    const body = await throughProvider("google", "cndctr", "https://cndctr.app/api/auth/callback");
    const logout = await fetch(base + `/realms/cumulus/protocol/openid-connect/logout?${new URLSearchParams({
      id_token_hint: body.id_token,
      client_id: "cndctr",
      post_logout_redirect_uri: "https://cndctr.app/bye",
      state: "out",
    })}`, { redirect: "manual" });
    assert.equal(logout.status, 302);
    const to = new URL(logout.headers.get("location")!);
    assert.equal(to.origin + to.pathname, "https://cndctr.app/bye");
    assert.equal(to.searchParams.get("state"), "out");
    assert.equal((await fetch(base + "/api/id/userinfo", { headers: { authorization: `Bearer ${body.access_token}` } })).status, 401);

    const again = await throughProvider("google", "cndctr", "https://cndctr.app/api/auth/callback");
    const revoked = await fetch(base + "/api/id/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://cndctr.app" },
      body: new URLSearchParams({ token: again.access_token }).toString(),
    });
    assert.equal(revoked.status, 200);
    assert.equal((await fetch(base + "/api/id/userinfo", { headers: { authorization: `Bearer ${again.access_token}` } })).status, 401);
    const unknown = await fetch(base + "/realms/cumulus/protocol/openid-connect/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "not-a-token" }).toString(),
    });
    assert.equal(unknown.status, 200);
  });

  it("serves the button pointed at the ID host", async () => {
    const res = await fetch(base + "/id/button.js");
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /https:\/\/id\.cumuluscloud\.app/);
    assert.match(text, /dataset\.issuer/);
  });
});

describe("OpenID Connect stays off without a signing key", () => {
  let server: Server;
  let base: string;

  before(async () => {
    const signer = generateSigner();
    const ledger = new Ledger(undefined, { authorizedSigners: [signer.publicKey] });
    const cid = new CidService({ ledger, signer, rpId: "localhost", origins: ["http://localhost"] });
    const crm = new SpectreCRM({ ledger, signer });
    const app = createApp({
      cid, crm, ai: {}, publicDir: join(here, "../../public"), secureCookies: false,
      origin: "http://localhost", oidcSigner: null,
    });
    server = app.server();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => new Promise<void>((r) => server.close(() => r())));

  it("keeps passkey sign-in and hides discovery", async () => {
    const discovery = await fetch(base + "/realms/cumulus/.well-known/openid-configuration");
    assert.equal(discovery.status, 404);
    const root = await fetch(base + "/.well-known/openid-configuration");
    assert.equal(root.status, 404);
    const signin = await fetch(base + "/api/auth/signin", { method: "POST", headers: { "content-type": "application/json", "x-spectre": "1" }, body: "{}" });
    assert.equal(signin.status, 200);
    const q = new URLSearchParams({
      client_id: "scalvs", redirect_uri: "https://scalvs.app/", code_challenge: "a".repeat(43), code_challenge_method: "S256", state: "s",
    });
    const auth = await fetch(base + `/api/id/authorize?${q}`, { redirect: "manual" });
    assert.equal(auth.status, 302);
    assert.match(auth.headers.get("location") ?? "", /^\/\?next=%2Fapi%2Fid%2Fauthorize/);
  });
});

describe("button defaults", () => {
  it("leaves the Mail copy pointed at mail.cumuluscloud.app", () => {
    const mail = readFileSync(join(here, "../../../cumulus-mail/public/id/button.js"), "utf8");
    const id = readFileSync(join(here, "../../public/id/button.js"), "utf8");
    assert.match(mail, /\|\| "https:\/\/mail\.cumuluscloud\.app"/);
    assert.match(id, /\|\| "https:\/\/id\.cumuluscloud\.app"/);
  });
});
