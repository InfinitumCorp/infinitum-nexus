import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { join } from "node:path";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { createCumulus } from "@infinitum/cumulus";
import { createMailApp } from "./app.ts";

/**
 * "Continue with Google" and "Continue with Apple" on Cumulus://Mail, end to end through the
 * app's routes, against simulated providers that answer Google's and Apple's real endpoint URLs.
 */

const users: Record<string, Record<string, unknown>> = {
  google: { sub: "g-1", email: "rivera@gmail.example", email_verified: true, name: "Alex Rivera" },
  apple: { sub: "ap-2", email: "x1@privaterelay.appleid.example", email_verified: "true" },
};
const issuers: Record<string, string> = { google: "https://accounts.google.com", apple: "https://appleid.apple.com" };
const tokenHosts: Record<string, string> = { "oauth2.googleapis.com": "google", "appleid.apple.com": "apple" };

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const applePem = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const idToken = (claims: Record<string, unknown>) => {
  const body = `${enc({ alg: "RS256", kid: "k1" })}.${enc(claims)}`;
  return `${body}.${sign("sha256", Buffer.from(body), privateKey).toString("base64url")}`;
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/** Codes the "provider" issued after the user approved, with what the token call must prove. */
const grants = new Map<string, { provider: string; nonce: string; challenge: string; clientId: string; redirectUri: string }>();
const tokenForms: Record<string, URLSearchParams> = {};

const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (/certs|keys/.test(url.pathname)) return json({ keys: [jwk] });
  const provider = tokenHosts[url.host];
  if (provider && init?.method === "POST") {
    const form = new URLSearchParams(String(init.body));
    tokenForms[provider] = form;
    const g = grants.get(form.get("code") ?? "");
    if (!g || g.provider !== provider || g.redirectUri !== form.get("redirect_uri")) return json({ error: "invalid_grant" }, 400);
    if (createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") !== g.challenge) return json({ error: "invalid_grant" }, 400);
    const now = Math.floor(Date.now() / 1000);
    return json({ access_token: "at", id_token: idToken({ iss: issuers[provider], aud: g.clientId, nonce: g.nonce, iat: now, exp: now + 600, ...users[provider] }) });
  }
  return json({ error: "not found" }, 404);
}) as typeof fetch;

let base = "";
let suite: ReturnType<typeof createCumulus>;
let server: ReturnType<ReturnType<typeof createMailApp>["server"]>;

before(async () => {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  base = `http://localhost:${port}`;
  const signer = generateSigner();
  suite = createCumulus({
    ledger: new Ledger(undefined, { authorizedSigners: [signer.publicKey] }),
    signer,
    rpId: "localhost",
    origins: [base],
    mailOrigin: base,
    social: {
      providers: {
        google: { clientId: "google-client", clientSecret: "google-secret" },
        apple: { clientId: "app.cumuluscloud.mail.signin", apple: { teamId: "TEAM123456", keyId: "KEY1234567", privateKeyPem: applePem } },
      },
      fetchImpl,
    },
  });
  server = createMailApp({ suite, publicDir: join(import.meta.dirname, "..", "public"), origin: base, secureCookies: false }).server();
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
});
after(() => new Promise<void>((r) => server.close(() => r())));

const cookieValue = (res: Response, name: string) => {
  for (const c of res.headers.getSetCookie()) if (c.startsWith(`${name}=`)) return c.split(";")[0]!;
  return undefined;
};

/** Start sign-in, then play the provider: approve and hand back a code bound to the request. */
async function start(provider: string) {
  const res = await fetch(`${base}/api/auth/oauth/${provider}/start`, { redirect: "manual" });
  assert.equal(res.status, 302);
  const to = new URL(res.headers.get("location")!);
  const oauthCookie = cookieValue(res, "cmail_oauth");
  assert.ok(oauthCookie, "binds the sign-in to this browser");
  const code = `code-${provider}-${grants.size}`;
  grants.set(code, {
    provider,
    nonce: to.searchParams.get("nonce")!,
    challenge: to.searchParams.get("code_challenge")!,
    clientId: to.searchParams.get("client_id")!,
    redirectUri: to.searchParams.get("redirect_uri")!,
  });
  return { to, code, state: to.searchParams.get("state")!, oauthCookie };
}

async function me(session: string) {
  const res = await fetch(`${base}/api/me`, { headers: { cookie: session } });
  return { status: res.status, data: (await res.json()) as any };
}

describe("Sign in with Google and Apple", () => {
  it("offers both providers on the sign-in page", async () => {
    const res = await fetch(`${base}/api/auth/providers`);
    assert.deepEqual(await res.json(), [{ id: "google", label: "Google" }, { id: "apple", label: "Apple" }]);
  });

  it("Continue with Google creates a CID with a mailbox and signs in", async () => {
    const { to, code, state, oauthCookie } = await start("google");
    assert.equal(to.origin + to.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    assert.equal(to.searchParams.get("redirect_uri"), `${base}/api/auth/oauth/google/callback`);
    assert.equal(to.searchParams.get("code_challenge_method"), "S256");

    const cb = await fetch(`${base}/api/auth/oauth/google/callback?code=${code}&state=${state}`, { headers: { cookie: oauthCookie }, redirect: "manual" });
    assert.equal(cb.status, 302);
    assert.equal(cb.headers.get("location"), "/");
    const session = cookieValue(cb, "cmail_session");
    assert.ok(session, "issues a session");
    assert.equal(tokenForms.google!.get("client_secret"), "google-secret");

    const who = await me(session);
    assert.equal(who.status, 200, JSON.stringify(who.data));
    assert.match(JSON.stringify(who.data), /@cumuluscloud\.app|@localhost/);
  });

  it("Continue with Apple works through Apple's form_post callback", async () => {
    const { to, code, state, oauthCookie } = await start("apple");
    assert.equal(to.origin + to.pathname, "https://appleid.apple.com/auth/authorize");
    assert.equal(to.searchParams.get("response_mode"), "form_post");

    const cb = await fetch(`${base}/api/auth/oauth/apple/callback`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: oauthCookie },
      body: new URLSearchParams({ code, state }).toString(),
      redirect: "manual",
    });
    assert.equal(cb.status, 302);
    assert.equal(cb.headers.get("location"), "/");
    const session = cookieValue(cb, "cmail_session");
    assert.ok(session);
    // Apple's client secret is an ES256 JWT signed with the team's key.
    const secret = tokenForms.apple!.get("client_secret")!;
    const [header, payload] = secret.split(".").slice(0, 2).map((p) => JSON.parse(Buffer.from(p, "base64url").toString()));
    assert.equal(header.alg, "ES256");
    assert.equal(header.kid, "KEY1234567");
    assert.equal(payload.iss, "TEAM123456");
    assert.equal(payload.sub, "app.cumuluscloud.mail.signin");
    assert.equal((await me(session)).status, 200);
  });

  it("signing in with Google again returns to the same CID", async () => {
    const first = await start("google");
    const a = await fetch(`${base}/api/auth/oauth/google/callback?code=${first.code}&state=${first.state}`, { headers: { cookie: first.oauthCookie }, redirect: "manual" });
    const before = await me(cookieValue(a, "cmail_session")!);
    const again = await start("google");
    const b = await fetch(`${base}/api/auth/oauth/google/callback?code=${again.code}&state=${again.state}`, { headers: { cookie: again.oauthCookie }, redirect: "manual" });
    const after = await me(cookieValue(b, "cmail_session")!);
    assert.equal(JSON.stringify(after.data.account?.cid ?? after.data.cid ?? after.data), JSON.stringify(before.data.account?.cid ?? before.data.cid ?? before.data));
  });

  it("refuses a callback from a different browser than the one that started", async () => {
    const { code, state } = await start("google");
    const cb = await fetch(`${base}/api/auth/oauth/google/callback?code=${code}&state=${state}`, { redirect: "manual" });
    assert.equal(cb.status, 302);
    assert.match(cb.headers.get("location")!, /^\/#\/signin-error\//);
    assert.equal(cookieValue(cb, "cmail_session"), undefined);
  });

  it("a cancelled sign-in goes back to the sign-in page", async () => {
    const cb = await fetch(`${base}/api/auth/oauth/apple/callback`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "error=user_cancelled_authorize",
      redirect: "manual",
    });
    assert.equal(cb.status, 302);
    assert.match(cb.headers.get("location")!, /signin-error/);
  });
});
