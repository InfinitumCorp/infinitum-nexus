import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { CidService, CidError, hotp, base32Decode, type SocialCredentials, type SocialProviderId } from "./index.ts";
import { PROVIDERS, SocialClient, type PendingAuth } from "./social.ts";
import { VirtualAuthenticator } from "./testing/virtual-authenticator.ts";

const REDIRECT = "https://spectre.infinitum.example/api/auth/oauth/callback";
const CHATGPT_ISSUER = "https://auth.chatgpt.example"; // stand-in for OpenAI's partner issuer

/** Simulated identity providers answering the real endpoint URLs. */
function fakeProviders() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };
  const users: Partial<Record<SocialProviderId, Record<string, unknown>>> = {
    google: { sub: "g-111", email: "alex@gmail.example", email_verified: true, name: "Alex Rivera" },
    microsoft: { sub: "ms-222", tid: "tenant-9", email: "alex@outlook.example", name: "Alex Rivera" },
    apple: { sub: "ap-333", email: "abc@privaterelay.appleid.example", email_verified: "true" },
    chatgpt: { sub: "oai-444", email: "alex@chatgpt-user.example", email_verified: true, name: "Alex Rivera" },
  };
  const issuers: Record<string, string> = {
    google: "https://accounts.google.com",
    microsoft: "https://login.microsoftonline.com/tenant-9/v2.0",
    apple: "https://appleid.apple.com",
    chatgpt: CHATGPT_ISSUER,
  };
  const tokenHost: Record<string, SocialProviderId> = {
    "oauth2.googleapis.com": "google",
    "login.microsoftonline.com": "microsoft",
    "appleid.apple.com": "apple",
    "auth.chatgpt.example": "chatgpt",
  };
  const codes = new Map<string, { provider: SocialProviderId; nonce: string; challenge: string; clientId: string }>();
  const posted: Record<string, URLSearchParams> = {};
  const overrides: { issuer?: string; nonce?: string; aud?: string } = {};
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const idToken = (claims: Record<string, unknown>) => {
    const body = `${enc({ alg: "RS256", kid: "test-key" })}.${enc(claims)}`;
    return `${body}.${sign("sha256", Buffer.from(body), privateKey).toString("base64url")}`;
  };
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/.well-known/openid-configuration")) {
      return json({ issuer: CHATGPT_ISSUER, authorization_endpoint: `${CHATGPT_ISSUER}/authorize`, token_endpoint: `${CHATGPT_ISSUER}/token`, jwks_uri: `${CHATGPT_ISSUER}/jwks` });
    }
    if (/certs|keys|jwks/.test(url.pathname)) return json({ keys: [jwk] });
    if (url.host === "github.com" && url.pathname === "/login/oauth/access_token") {
      posted.github = new URLSearchParams(String(init?.body));
      return json({ access_token: "gho_test", token_type: "bearer" });
    }
    if (url.host === "api.github.com" && url.pathname === "/user") return json({ id: 555, login: "alexr", name: "Alex Rivera" });
    if (url.host === "api.github.com" && url.pathname === "/user/emails") return json([{ email: "alex@github.example", primary: true, verified: true }]);
    const provider = tokenHost[url.host];
    if (provider && init?.method === "POST") {
      const form = new URLSearchParams(String(init.body));
      posted[provider] = form;
      const grant = codes.get(form.get("code") ?? "");
      if (!grant || grant.provider !== provider) return json({ error: "invalid_grant" }, 400);
      // PKCE: the verifier must hash to the challenge sent at the start.
      const { createHash } = await import("node:crypto");
      if (createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") !== grant.challenge) return json({ error: "invalid_grant", error_description: "PKCE failed" }, 400);
      const now = Math.floor(Date.now() / 1000);
      return json({
        access_token: "at",
        id_token: idToken({
          iss: overrides.issuer ?? issuers[provider],
          aud: overrides.aud ?? grant.clientId,
          nonce: overrides.nonce ?? grant.nonce,
          iat: now,
          exp: now + 600,
          ...users[provider],
        }),
      });
    }
    return json({ error: "not found" }, 404);
  }) as typeof fetch;

  /** What the provider does when the person approves: hands back a code for this request. */
  const approve = (authorizeUrl: string, provider: SocialProviderId) => {
    const u = new URL(authorizeUrl);
    const code = `code-${Math.random().toString(36).slice(2)}`;
    codes.set(code, { provider, nonce: u.searchParams.get("nonce") ?? "", challenge: u.searchParams.get("code_challenge")!, clientId: u.searchParams.get("client_id")! });
    return { code, state: u.searchParams.get("state")!, url: u };
  };
  return { fetchImpl, approve, posted, overrides, users };
}

function setup(only?: SocialProviderId[]) {
  const apple = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const all: Partial<Record<SocialProviderId, SocialCredentials>> = {
    google: { clientId: "google-client", clientSecret: "gs" },
    github: { clientId: "github-client", clientSecret: "ghs" },
    microsoft: { clientId: "ms-client", clientSecret: "mss" },
    apple: { clientId: "id.infinitum.cid", apple: { teamId: "TEAM123", keyId: "KEY123", privateKeyPem: apple.privateKey.export({ format: "pem", type: "pkcs8" }) as string } },
    chatgpt: { clientId: "chatgpt-client", clientSecret: "cs", issuer: CHATGPT_ISSUER },
  };
  const providers = only ? Object.fromEntries(only.map((p) => [p, all[p]])) : all;
  const fake = fakeProviders();
  let now = new Date();
  const signer = generateSigner();
  const ledger = new Ledger(undefined, { authorizedSigners: [signer.publicKey] });
  const cid = new CidService({ ledger, signer, rpId: "infinitum.example", origins: ["https://infinitum.example"], clock: () => now, social: { providers, fetchImpl: fake.fetchImpl } });
  return { cid, ledger, fake, applePublic: apple.publicKey, advance: (ms: number) => { now = new Date(now.getTime() + ms); }, now: () => now };
}

async function signInWith(cid: CidService, fake: ReturnType<typeof fakeProviders>, provider: SocialProviderId, linkToCid?: string) {
  const { url, state } = await cid.startSocialSignIn(provider, REDIRECT, linkToCid);
  const { code } = fake.approve(url, provider);
  return cid.finishSocialSignIn(provider, { state, code, browserState: state }, "Laptop");
}

const rejectsWith = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: unknown) => e instanceof CidError && e.code === code);

describe("CID social sign-in", () => {
  it("accepts a discovery issuer with a trailing slash", async () => {
    const fake = fakeProviders();
    const client = new SocialClient(fake.fetchImpl);
    const pending: PendingAuth = {
      state: "s",
      provider: "chatgpt",
      nonce: "n",
      codeVerifier: "v",
      redirectUri: REDIRECT,
      expiresAt: Date.now() + 60_000,
    };
    const url = await client.authorizeUrl(PROVIDERS.chatgpt, { clientId: "chatgpt-client", issuer: `${CHATGPT_ISSUER}/` }, pending, "challenge");
    assert.equal(new URL(url).origin + new URL(url).pathname, `${CHATGPT_ISSUER}/authorize`);
  });

  it("offers only providers that are configured", () => {
    const { cid } = setup(["google", "github"]);
    assert.deepEqual(cid.socialProvidersEnabled().map((p) => p.id), ["google", "github"]);
  });

  it("builds a PKCE authorization request with state and nonce", async () => {
    const { cid } = setup(["google"]);
    const { url, state } = await cid.startSocialSignIn("google", REDIRECT);
    const u = new URL(url);
    assert.equal(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    assert.equal(u.searchParams.get("state"), state);
    assert.equal(u.searchParams.get("code_challenge_method"), "S256");
    assert.ok(u.searchParams.get("nonce"));
    assert.equal(u.searchParams.get("scope"), "openid email profile");
  });

  for (const provider of ["google", "github", "microsoft", "apple", "chatgpt"] as SocialProviderId[]) {
    it(`creates a CID on first ${provider} sign-in and signs back in to the same one`, async () => {
      const { cid, fake } = setup();
      const first = await signInWith(cid, fake, provider);
      assert.equal(first.status, "ok");
      if (first.status !== "ok") return;
      assert.equal(first.created, true);
      assert.equal(first.session.method, `social:${provider}`);
      const again = await signInWith(cid, fake, provider);
      assert.ok(again.status === "ok" && !again.created && again.session.cid === first.session.cid);
      assert.equal(cid.linkedIdentities(first.session.cid)[0].provider, provider);
    });
  }

  it("names the new CID after the GitHub login or email", async () => {
    const { cid, fake } = setup();
    const gh = await signInWith(cid, fake, "github");
    const g = await signInWith(cid, fake, "google");
    assert.ok(gh.status === "ok" && g.status === "ok");
    if (gh.status !== "ok" || g.status !== "ok") return;
    assert.equal(cid.getAccount(gh.session.cid).username, "alexr");
    assert.equal(cid.getAccount(g.session.cid).username, "alex");
    assert.equal(cid.getAccount(g.session.cid).mailAddress, "alex@cumuluscloud.app");
  });

  it("sends Apple a valid ES256 client-secret JWT", async () => {
    const { cid, fake, applePublic } = setup(["apple"]);
    await signInWith(cid, fake, "apple");
    const secret = fake.posted.apple.get("client_secret")!;
    const [h, p, s] = secret.split(".");
    assert.ok(verify("sha256", Buffer.from(`${h}.${p}`), { key: applePublic, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")));
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    assert.equal(claims.iss, "TEAM123");
    assert.equal(claims.sub, "id.infinitum.cid");
  });

  it("asks Apple to post the result back as a form", async () => {
    const { cid } = setup(["apple"]);
    const { url } = await cid.startSocialSignIn("apple", REDIRECT);
    assert.equal(new URL(url).searchParams.get("response_mode"), "form_post");
  });

  it("rejects a callback that didn't start in the same browser (login CSRF)", async () => {
    const { cid, fake } = setup(["google"]);
    const { url, state } = await cid.startSocialSignIn("google", REDIRECT);
    const { code } = fake.approve(url, "google");
    await rejectsWith(cid.finishSocialSignIn("google", { state, code, browserState: "attacker-state" }, "x"), "challenge_expired");
  });

  it("rejects replayed and expired requests", async () => {
    const { cid, fake, advance } = setup(["google"]);
    const { url, state } = await cid.startSocialSignIn("google", REDIRECT);
    const { code } = fake.approve(url, "google");
    await cid.finishSocialSignIn("google", { state, code, browserState: state }, "x");
    await rejectsWith(cid.finishSocialSignIn("google", { state, code, browserState: state }, "x"), "challenge_expired");
    const second = await cid.startSocialSignIn("google", REDIRECT);
    advance(11 * 60_000);
    await rejectsWith(cid.finishSocialSignIn("google", { state: second.state, code: "c", browserState: second.state }, "x"), "challenge_expired");
  });

  it("rejects ID tokens with the wrong nonce, audience or issuer", async () => {
    for (const bad of [{ nonce: "replayed" }, { aud: "someone-elses-app" }, { issuer: "https://evil.example" }]) {
      const { cid, fake } = setup(["google"]);
      Object.assign(fake.overrides, bad);
      await rejectsWith(signInWith(cid, fake, "google"), "social_failed");
    }
  });

  it("checks Microsoft's tenant issuer against the token's tenant", async () => {
    const { cid, fake } = setup(["microsoft"]);
    fake.overrides.issuer = "https://login.microsoftonline.com/other-tenant/v2.0";
    await rejectsWith(signInWith(cid, fake, "microsoft"), "social_failed");
  });

  it("never joins accounts by matching email", async () => {
    const { cid, fake } = setup(["google", "chatgpt"]);
    fake.users.chatgpt!.email = fake.users.google!.email; // same address at two providers
    const a = await signInWith(cid, fake, "google");
    const b = await signInWith(cid, fake, "chatgpt");
    assert.ok(a.status === "ok" && b.status === "ok");
    if (a.status === "ok" && b.status === "ok") assert.notEqual(a.session.cid, b.session.cid);
  });

  it("links a provider to a signed-in CID, and won't steal one linked elsewhere", async () => {
    const { cid, fake } = setup(["google", "github"]);
    const me = await cid.createAccount({ username: "jordan" });
    const linked = await signInWith(cid, fake, "github", me.cid);
    assert.deepEqual(linked, { status: "linked", cid: me.cid });
    const viaGithub = await signInWith(cid, fake, "github");
    assert.ok(viaGithub.status === "ok" && viaGithub.session.cid === me.cid);

    const other = await signInWith(cid, fake, "google");
    assert.equal(other.status, "ok");
    await rejectsWith(signInWith(cid, fake, "google", me.cid), "identity_in_use");
  });

  it("still requires the authenticator-app code when multifactor is on", async () => {
    const { cid, fake, now } = setup(["google"]);
    const first = await signInWith(cid, fake, "google");
    if (first.status !== "ok") throw new Error();
    const { secret } = cid.enrollTotp(first.session.cid);
    const code = (d: Date) => hotp(base32Decode(secret), Math.floor(d.getTime() / 30_000));
    await cid.confirmTotp(first.session.cid, code(now()));
    const second = await signInWith(cid, fake, "google");
    assert.equal(second.status, "mfa_required");
    if (second.status !== "mfa_required") return;
    const done = await cid.completeMfa(second.mfaToken, code(new Date(now().getTime() + 30_000)));
    assert.equal(done.session.method, "social:google+totp");
  });

  it("won't unlink the only way to sign in, but allows it once a passkey exists", async () => {
    const { cid, fake } = setup(["google"]);
    const r = await signInWith(cid, fake, "google");
    if (r.status !== "ok") throw new Error();
    await rejectsWith(cid.unlinkIdentity(r.session.cid, "google"), "last_key");
    const auth = new VirtualAuthenticator();
    const opts = cid.startAuthenticatorRegistration(r.session.cid);
    await cid.finishAuthenticatorRegistration(r.session.cid, auth.create({ challenge: opts.challenge, origin: "https://infinitum.example", rpId: "infinitum.example" }));
    await cid.unlinkIdentity(r.session.cid, "google");
    assert.equal(cid.linkedIdentities(r.session.cid).length, 0);
  });

  it("keeps provider account IDs and emails off the ledger", async () => {
    const { cid, fake, ledger } = setup(["google"]);
    await signInWith(cid, fake, "google");
    const all = JSON.stringify(await ledger.entries());
    assert.ok(!all.includes("g-111") && !all.includes("gmail.example"));
    assert.equal((await ledger.verify()).ok, true);
  });

  it("refuses unconfigured providers", async () => {
    const { cid } = setup(["google"]);
    await rejectsWith(cid.startSocialSignIn("github", REDIRECT), "provider_unavailable");
    await rejectsWith(cid.startSocialSignIn("myspace", REDIRECT), "provider_unavailable");
  });
});
