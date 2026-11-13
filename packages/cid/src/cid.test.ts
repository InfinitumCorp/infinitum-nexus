import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { CidService, CidError, MAIL_DOMAIN, hotp, verifyTotp, base32Decode, base32Encode } from "./index.ts";
import { VirtualAuthenticator } from "./testing/virtual-authenticator.ts";
import { isDerEcdsaSignature } from "./webauthn.ts";
import { testRepository } from "./testing/copying-repository.ts";

const RP_ID = "id.cumuluscloud.app";
const ORIGIN = "https://id.cumuluscloud.app";

function setup(start = new Date("2026-11-04T12:00:00Z")) {
  let now = start;
  const signer = generateSigner();
  const ledger = new Ledger(undefined, { authorizedSigners: [signer.publicKey] });
  const cid = new CidService({ ledger, signer, rpId: RP_ID, origins: [ORIGIN], clock: () => now, repository: testRepository() });
  return { cid, ledger, advance: (ms: number) => { now = new Date(now.getTime() + ms); }, now: () => now };
}

async function withPasskey(cid: CidService, username: string, auth = new VirtualAuthenticator()) {
  const account = await cid.createAccount({ username });
  const kind = auth.userVerifying ? "passkey" : "security-key";
  const opts = await cid.startAuthenticatorRegistration(account.cid, kind);
  const reg = auth.create({ challenge: opts.challenge, origin: ORIGIN, rpId: RP_ID });
  const key = await cid.finishAuthenticatorRegistration(account.cid, reg, { kind });
  return { account, auth, key };
}

async function signIn(cid: CidService, auth: VirtualAuthenticator, credentialId: string) {
  const { challenge } = await cid.startSignIn();
  return cid.finishSignIn(auth.get({ credentialId, challenge, origin: ORIGIN }), "MacBook · VEIL");
}

const rejectsWith = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: unknown) => e instanceof CidError && e.code === code);

describe("CID accounts", () => {
  it("creates one account with mail address, ecosystem handle and free entitlements", async () => {
    const { cid, ledger } = setup();
    const a = await cid.createAccount({ username: "Alex" });
    assert.equal(a.username, "alex");
    assert.equal(a.mailAddress, `alex@${MAIL_DOMAIN}`);
    assert.equal(MAIL_DOMAIN, "cumuluscloud.app");
    assert.equal(cid.issuer, "https://id.cumuluscloud.app/realms/cumulus");
    assert.equal(cid.jwksUri, "https://id.cumuluscloud.app/realms/cumulus/protocol/openid-connect/certs");
    assert.equal(cid.issuerMetadata().id_host, "id.cumuluscloud.app");
    assert.equal(cid.corsAllowOrigin(ORIGIN), ORIGIN);
    assert.equal(cid.corsAllowOrigin("*"), null);
    assert.equal(cid.corsHeaders("https://cloud.cumuluscloud.app")["Access-Control-Allow-Origin"], "https://cloud.cumuluscloud.app");
    assert.equal(JSON.stringify(cid.corsHeaders("*")).includes("*"), false);
    assert.equal(a.handle, "@alex.veil");
    assert.equal(a.entitlements.storageGb, 15);
    assert.equal(a.entitlements.scalvs, "free");
    const [entry] = await ledger.query({ type: "identity", subject: a.cid });
    assert.equal(entry.payload.event, "account.created");
    assert.ok(!JSON.stringify(entry).includes("alex@"), "personal details stay off the ledger");
  });

  it("rejects taken, reserved and invalid usernames", async () => {
    const { cid } = setup();
    await cid.createAccount({ username: "alex" });
    await rejectsWith(cid.createAccount({ username: "ALEX" }), "taken");
    await rejectsWith(cid.createAccount({ username: "admin" }), "reserved");
    await rejectsWith(cid.createAccount({ username: "a" }), "invalid_username");
    await rejectsWith(cid.createAccount({ username: "bad name!" }), "invalid_username");
  });

  it("never issues ODIN° accounts through the consumer flow", async () => {
    const { cid } = setup();
    await rejectsWith(cid.createAccount({ username: "sgt-lee", accountType: "odin" }), "odin_separate");
  });
});

describe("CID passkeys and security keys", () => {
  it("registers a passkey and signs in with it (ES256)", async () => {
    const { cid } = setup();
    const { account, auth, key } = await withPasskey(cid, "alex");
    const { challenge } = await cid.startSignIn();
    const assertion = auth.get({ credentialId: key.credentialId, challenge, origin: ORIGIN });
    // WebAuthn §6.5.6: ES256 assertion signatures are ASN.1 DER, as real passkeys send them.
    const sig = Buffer.from(assertion.signature, "base64url");
    assert.equal(sig[0], 0x30, "ES256 signatures are a DER SEQUENCE");
    assert.ok(isDerEcdsaSignature(sig));
    const result = await cid.finishSignIn(assertion, "MacBook · VEIL");
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal((await cid.authenticate(result.token))?.account.cid, account.cid);
  });

  it("still accepts ES256 signatures sent as raw 64-byte r||s", async () => {
    const { cid } = setup();
    const { account, auth, key } = await withPasskey(cid, "alex");
    const { challenge } = await cid.startSignIn();
    const assertion = auth.get({ credentialId: key.credentialId, challenge, origin: ORIGIN, signatureEncoding: "ieee-p1363" });
    assert.equal(Buffer.from(assertion.signature, "base64url").length, 64);
    const result = await cid.finishSignIn(assertion, "MacBook · VEIL");
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal((await cid.authenticate(result.token))?.account.cid, account.cid);
  });

  it("rejects a tampered ES256 signature in either encoding", async () => {
    const { cid } = setup();
    const { auth, key } = await withPasskey(cid, "alex");
    for (const signatureEncoding of ["der", "ieee-p1363"] as const) {
      const { challenge } = await cid.startSignIn();
      const assertion = auth.get({ credentialId: key.credentialId, challenge, origin: ORIGIN, signatureEncoding });
      const sig = Buffer.from(assertion.signature, "base64url");
      sig[sig.length - 1] ^= 0x01;
      await rejectsWith(cid.finishSignIn({ ...assertion, signature: sig.toString("base64url") }, "MacBook · VEIL"), "webauthn_failed");
    }
  });

  it("supports Ed25519 passkeys", async () => {
    const { cid } = setup();
    const account = await cid.createAccount({ username: "sam" });
    const auth = new VirtualAuthenticator();
    const opts = await cid.startAuthenticatorRegistration(account.cid);
    const key = await cid.finishAuthenticatorRegistration(account.cid, auth.create({ challenge: opts.challenge, origin: ORIGIN, rpId: RP_ID, alg: "EdDSA" }));
    assert.equal((await signIn(cid, auth, key.credentialId)).status, "ok");
  });

  it("supports synced passkeys that always report a zero counter", async () => {
    const { cid } = setup();
    const { auth, key } = await withPasskey(cid, "alex", new VirtualAuthenticator({ useCounter: false }));
    assert.equal((await signIn(cid, auth, key.credentialId)).status, "ok");
    assert.equal((await signIn(cid, auth, key.credentialId)).status, "ok");
  });

  it("rejects a wildcard origin", () => {
    const signer = generateSigner();
    const ledger = new Ledger(undefined, { authorizedSigners: [signer.publicKey] });
    for (const origins of [["*"], ["https://*.cumuluscloud.app"]]) {
      assert.throws(
        () => new CidService({ ledger, signer, rpId: RP_ID, origins }),
        (e: unknown) => e instanceof CidError && e.code === "invalid_origin",
      );
    }
  });

  it("rejects a phishing site's origin", async () => {
    const { cid } = setup();
    const { auth, key } = await withPasskey(cid, "alex");
    const { challenge } = await cid.startSignIn();
    const resp = auth.get({ credentialId: key.credentialId, challenge, origin: "https://infinitum-login.example" });
    await rejectsWith(cid.finishSignIn(resp, "x"), "webauthn_failed");
  });

  it("rejects a credential created for a different site", async () => {
    const { cid } = setup();
    const { auth, key } = await withPasskey(cid, "alex");
    const { challenge } = await cid.startSignIn();
    const resp = auth.get({ credentialId: key.credentialId, challenge, origin: ORIGIN, rpIdOverride: "evil.example" });
    await rejectsWith(cid.finishSignIn(resp, "x"), "webauthn_failed");
  });

  it("rejects a replayed sign-in", async () => {
    const { cid } = setup();
    const { auth, key } = await withPasskey(cid, "alex");
    const { challenge } = await cid.startSignIn();
    const resp = auth.get({ credentialId: key.credentialId, challenge, origin: ORIGIN });
    await cid.finishSignIn(resp, "x");
    await rejectsWith(cid.finishSignIn(resp, "x"), "challenge_expired");
  });

  it("rejects an expired challenge", async () => {
    const { cid, advance } = setup();
    const { auth, key } = await withPasskey(cid, "alex");
    const { challenge } = await cid.startSignIn();
    advance(6 * 60_000);
    await rejectsWith(cid.finishSignIn(auth.get({ credentialId: key.credentialId, challenge, origin: ORIGIN }), "x"), "challenge_expired");
  });

  it("detects a cloned security key by its counter", async () => {
    const { cid } = setup();
    const { auth, key } = await withPasskey(cid, "alex");
    await signIn(cid, auth, key.credentialId); // counter now 2
    const { challenge } = await cid.startSignIn();
    const cloned = auth.get({ credentialId: key.credentialId, challenge, origin: ORIGIN, counterOverride: 2 });
    await rejectsWith(cid.finishSignIn(cloned, "x"), "webauthn_failed");
  });

  it("rejects a forged signature", async () => {
    const { cid } = setup();
    const { auth, key } = await withPasskey(cid, "alex");
    const { challenge } = await cid.startSignIn();
    const resp = auth.get({ credentialId: key.credentialId, challenge, origin: ORIGIN });
    const attacker = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const forged = sign("sha256", Buffer.from("anything"), attacker.privateKey).toString("base64url");
    await rejectsWith(cid.finishSignIn({ ...resp, signature: forged }, "x"), "webauthn_failed");
  });

  it("won't remove the last key on an account", async () => {
    const { cid } = setup();
    const { account, key } = await withPasskey(cid, "alex");
    await rejectsWith(cid.removeAuthenticator(account.cid, key.id), "last_key");
  });

  it("does not leak whether a username exists", async () => {
    const { cid } = setup();
    const opts = await cid.startSignIn("nobody-here");
    assert.deepEqual(opts.allowCredentials, []);
  });
});

describe("CID multifactor", () => {
  it("matches the RFC 6238 test vector", () => {
    const secret = Buffer.from("12345678901234567890");
    assert.equal(hotp(secret, Math.floor(59 / 30), 8), "94287082");
    assert.deepEqual(base32Decode(base32Encode(secret)), secret);
  });

  it("asks a security key without user verification for an authenticator-app code", async () => {
    const { cid, now } = setup();
    const { account, auth, key } = await withPasskey(cid, "alex", new VirtualAuthenticator({ userVerifying: false }));
    const { secret } = await cid.enrollTotp(account.cid);
    const codeAt = (d: Date) => hotp(base32Decode(secret), Math.floor(d.getTime() / 30_000));
    await cid.confirmTotp(account.cid, codeAt(now()));

    const first = await signIn(cid, auth, key.credentialId);
    assert.equal(first.status, "mfa_required");
    if (first.status !== "mfa_required") return;
    await rejectsWith(cid.completeMfa(first.mfaToken, "000000"), "mfa_failed");
    // The code used to confirm setup can't be replayed.
    await rejectsWith(cid.completeMfa(first.mfaToken, codeAt(now())), "mfa_failed");
    const next = new Date(now().getTime() + 30_000);
    const done = await cid.completeMfa(first.mfaToken, codeAt(next));
    assert.equal(done.session.method, "passkey+totp");
    // A code that completed one sign-in can't complete another (the used step is saved).
    const second = await signIn(cid, auth, key.credentialId);
    if (second.status !== "mfa_required") throw new Error("expected another MFA prompt");
    await rejectsWith(cid.completeMfa(second.mfaToken, codeAt(next)), "mfa_failed");
  });

  it("treats a user-verified passkey as already two-factor", async () => {
    const { cid, now } = setup();
    const { account, auth, key } = await withPasskey(cid, "alex");
    const { secret } = await cid.enrollTotp(account.cid);
    await cid.confirmTotp(account.cid, hotp(base32Decode(secret), Math.floor(now().getTime() / 30_000)));
    assert.equal((await signIn(cid, auth, key.credentialId)).status, "ok");
  });

  it("allows one step of clock drift", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    const t = new Date("2026-11-04T12:00:00Z");
    const prev = hotp(base32Decode(secret), Math.floor(t.getTime() / 30_000) - 1);
    assert.notEqual(verifyTotp(secret, prev, t), null);
  });
});

describe("CID sessions", () => {
  it("lists, revokes one, and signs out everywhere else", async () => {
    const { cid } = setup();
    const { account, auth, key } = await withPasskey(cid, "alex");
    const s1 = await signIn(cid, auth, key.credentialId);
    const s2 = await signIn(cid, auth, key.credentialId);
    const s3 = await signIn(cid, auth, key.credentialId);
    if (s1.status !== "ok" || s2.status !== "ok" || s3.status !== "ok") throw new Error("sign-in failed");
    assert.equal((await cid.listSessions(account.cid)).length, 3);
    assert.ok(!("tokenHash" in (await cid.listSessions(account.cid))[0]));

    await cid.revokeSession(account.cid, s1.session.id);
    assert.equal(await cid.authenticate(s1.token), null);

    assert.equal(await cid.revokeAllSessions(account.cid, s3.session.id), 1);
    assert.equal(await cid.authenticate(s2.token), null);
    assert.ok(await cid.authenticate(s3.token));
  });

  it("expires sessions", async () => {
    const { cid, advance } = setup();
    const { auth, key } = await withPasskey(cid, "alex");
    const s = await signIn(cid, auth, key.credentialId);
    if (s.status !== "ok") throw new Error();
    advance(31 * 86_400_000);
    assert.equal(await cid.authenticate(s.token), null);
  });

  it("rejects unknown tokens", async () => {
    const { cid } = setup();
    assert.equal(await cid.authenticate("not-a-token"), null);
  });
});

describe("CID permissions dashboard", () => {
  it("accepts the earlier :\\ARCHITECT\\ app ids for one release", async () => {
    const { cid } = setup();
    const a = await cid.createAccount({ username: "alex" });
    const g = await cid.grant(a.cid, "architct", ["drive:read"]);
    assert.equal(g.app, "architect");
    await cid.grant(a.cid, "cndctr", ["contacts:read"]);
    assert.ok(await cid.can(a.cid, "architect", "drive:read"));
    assert.ok(await cid.can(a.cid, "architect", "contacts:read"));
    assert.ok(await cid.can(a.cid, "architct", "drive:read"));
  });

  it("grants app by app, records every change on Firmament, and revokes", async () => {
    const { cid, ledger } = setup();
    const a = await cid.createAccount({ username: "alex" });
    await cid.grant(a.cid, "spectre", ["contacts:read"]);
    const merged = await cid.grant(a.cid, "spectre", ["calendar:read"]);
    await cid.grant(a.cid, "scalvs", ["drive:read"]);
    assert.deepEqual(merged.scopes, ["calendar:read", "contacts:read"]);
    assert.ok(await cid.can(a.cid, "spectre", "contacts:read"));
    assert.ok(!await cid.can(a.cid, "fabric", "contacts:read"));

    await cid.revoke(a.cid, "spectre", ["contacts:read"]);
    assert.ok(!await cid.can(a.cid, "spectre", "contacts:read"));
    assert.ok(await cid.can(a.cid, "spectre", "calendar:read"));
    await cid.revoke(a.cid, "scalvs");
    assert.deepEqual((await cid.permissions(a.cid)).map((g) => g.app), ["spectre"]);

    const history = await cid.permissionHistory(a.cid);
    assert.deepEqual(history.map((e) => e.type), ["grant", "grant", "grant", "revoke", "revoke"]);
    const current = (await cid.permissions(a.cid))[0];
    assert.ok(history.some((e) => e.hash === current.ledgerHash));
    assert.deepEqual(await ledger.verify(), { ok: true, length: (await ledger.entries()).length });
  });

  it("rejects unknown apps and malformed scopes", async () => {
    const { cid } = setup();
    const a = await cid.createAccount({ username: "alex" });
    await rejectsWith(cid.grant(a.cid, "not-an-app", ["x:y"]), "unknown_app");
    await rejectsWith(cid.grant(a.cid, "spectre", ["everything"]), "invalid_scope");
  });
});

describe("CID organizations and SSO", () => {
  function idp() {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
    const issue = (claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: "k1" }) => {
      const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
      const body = `${enc(header)}.${enc(claims)}`;
      return `${body}.${sign("sha256", Buffer.from(body), privateKey).toString("base64url")}`;
    };
    return { jwk, issue };
  }

  async function orgWithSso(cid: CidService) {
    const admin = await cid.createAccount({ username: "it-admin" });
    const org = await cid.createOrganization("Acme Logistics", admin.cid);
    const provider = idp();
    await cid.configureSso(org.id, admin.cid, {
      issuer: "https://login.acme.example",
      audience: "infinitum-cid",
      jwks: [provider.jwk],
      emailDomain: "acme.example",
    });
    return { admin, org, provider };
  }

  const base = (now: Date) => ({
    iss: "https://login.acme.example",
    aud: "infinitum-cid",
    sub: "00u123",
    email: "jordan.kim@acme.example",
    email_verified: true,
    iat: Math.floor(now.getTime() / 1000),
    exp: Math.floor(now.getTime() / 1000) + 600,
  });

  it("creates the member's CID on first sign-in and reuses it after", async () => {
    const { cid, now } = setup();
    const { admin, org, provider } = await orgWithSso(cid);
    const first = await cid.signInWithSso(org.id, provider.issue(base(now())), "Work laptop");
    const second = await cid.signInWithSso(org.id, provider.issue(base(now())), "Phone");
    assert.equal(first.session.cid, second.session.cid);
    const member = await cid.getAccount(first.session.cid);
    assert.equal(member.username, "jordan.kim");
    assert.equal(member.orgId, org.id);
    assert.equal((await cid.orgMembers(org.id, admin.cid)).length, 2);
  });

  it("rejects tokens for another app, expired tokens, unsigned tokens and outside domains", async () => {
    const { cid, now } = setup();
    const { org, provider } = await orgWithSso(cid);
    await rejectsWith(cid.signInWithSso(org.id, provider.issue({ ...base(now()), aud: "other-app" }), "x"), "sso_failed");
    await rejectsWith(cid.signInWithSso(org.id, provider.issue({ ...base(now()), exp: 1 }), "x"), "sso_failed");
    await rejectsWith(cid.signInWithSso(org.id, provider.issue(base(now()), { alg: "none" }), "x"), "sso_failed");
    await rejectsWith(cid.signInWithSso(org.id, provider.issue({ ...base(now()), email: "x@gmail.com" }), "x"), "sso_failed");
    const forged = provider.issue(base(now())).split(".");
    forged[1] = Buffer.from(JSON.stringify({ ...base(now()), sub: "someone-else" })).toString("base64url");
    await rejectsWith(cid.signInWithSso(org.id, forged.join("."), "x"), "sso_failed");
  });

  it("lets admins sign a member out everywhere, and nobody else", async () => {
    const { cid, now } = setup();
    const { admin, org, provider } = await orgWithSso(cid);
    const s = await cid.signInWithSso(org.id, provider.issue(base(now())), "Laptop");
    const outsider = await cid.createAccount({ username: "outsider" });
    await rejectsWith(cid.adminRevokeMemberSessions(org.id, outsider.cid, s.session.cid), "forbidden");
    assert.equal(await cid.adminRevokeMemberSessions(org.id, admin.cid, s.session.cid), 1);
    assert.equal(await cid.authenticate(s.token), null);
  });
});

it("registers LBRNTH with explicit scopes, no free access, and live revocation", async () => {
  const { cid } = setup();
  const account = await cid.createAccount({ username: "labyrinth-client" });
  assert.equal(await cid.can(account.cid, "LBRNTH", "repo:read"), false);
  await cid.grant(account.cid, "LBRNTH", ["repo:read", "repo:write", "repo:admin"]);
  assert.equal(await cid.can(account.cid, "LBRNTH", "repo:read"), true);
  assert.equal(await cid.can(account.cid, "LBRNTH", "repo:write"), true);
  await cid.revoke(account.cid, "LBRNTH", ["repo:write"]);
  assert.equal(await cid.can(account.cid, "LBRNTH", "repo:write"), false);
  assert.equal(await cid.can(account.cid, "LBRNTH", "repo:read"), true);
  await cid.revoke(account.cid, "LBRNTH");
  assert.equal(await cid.can(account.cid, "LBRNTH", "repo:read"), false);
});

describe("CID storage boundary", () => {
  it("refuses a synchronous view on a repository that isn't the in-memory store", async () => {
    const { CopyingCidRepository } = await import("./testing/copying-repository.ts");
    const signer = generateSigner();
    const cid = new CidService({ ledger: new Ledger(undefined, { authorizedSigners: [signer.publicKey] }), signer, rpId: RP_ID, origins: [ORIGIN], repository: new CopyingCidRepository() });
    assert.throws(() => cid.syncView(), (e: CidError) => e.code === "sync_unavailable");
    const memory = setup().cid;
    if (!process.env.CID_TEST_COPYING_REPO && !process.env.CID_TEST_PG && !process.env.CID_TEST_REMOTE_REPO) assert.equal(typeof memory.syncView().can, "function");
  });
});

describe("CID OpenID Connect client mode (sign-in at the standalone issuer)", () => {
  const SUB = "cid_11111111-2222-4333-8444-555555555555";
  const ORG = "org_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

  it("keeps a started sign-in once, through the repository, and drops expired ones", async () => {
    const { cid, advance } = setup();
    await cid.rememberIssuerLogin("state-1", { nonce: "n1", verifier: "v1", redirectUri: "https://spectre.example/cb", next: "/#/today" });
    const login = await cid.takeIssuerLogin("state-1");
    assert.equal(login?.nonce, "n1");
    assert.equal(login?.next, "/#/today");
    assert.equal(await cid.takeIssuerLogin("state-1"), null, "single use");
    await cid.rememberIssuerLogin("state-2", { nonce: "n2", verifier: "v2", redirectUri: "https://spectre.example/cb" });
    advance(11 * 60_000);
    assert.equal(await cid.takeIssuerLogin("state-2"), null, "expired after 10 minutes");
  });

  it("creates the local account, its organization and admin role from the claims, and saves them", async () => {
    const { cid } = setup();
    const first = await cid.signInFromIssuer({ sub: SUB, preferred_username: "grace", email: "grace@cumuluscloud.app", org_id: ORG, org_name: "Hopper Labs", org_role: "admin" }, "Browser", "id-token-1");
    assert.equal(first.created, true);
    const account = await cid.getAccount(SUB);
    assert.equal(account.username, "grace");
    assert.equal(account.orgId, ORG, "the membership was written back");
    assert.equal((await cid.organizationMembership(SUB))?.admin, true);
    assert.equal((await cid.authenticate(first.token))?.account.cid, SUB);
    assert.ok(!(await cid.listSessions(SUB)).some((s) => "idTokenHint" in s), "the ID token never leaves in session lists");
    // Signed in again as a member: the admin role follows the issuer, and nothing is created twice.
    const again = await cid.signInFromIssuer({ sub: SUB, preferred_username: "grace", org_id: ORG, org_role: "member" }, "Browser");
    assert.equal(again.created, false);
    assert.equal((await cid.organizationMembership(SUB))?.admin, false);
    // No org_id any more: an issuer-sourced organization is left.
    await cid.signInFromIssuer({ sub: SUB }, "Browser");
    assert.equal((await cid.getAccount(SUB)).orgId, undefined);
  });

  it("refuses a subject that isn't a cid, and picks a free username when the wanted one is taken", async () => {
    const { cid } = setup();
    await rejectsWith(cid.signInFromIssuer({ sub: "user-123" }, "Browser"), "invalid_subject");
    await cid.createAccount({ username: "grace" });
    await cid.signInFromIssuer({ sub: SUB, preferred_username: "grace" }, "Browser");
    assert.notEqual((await cid.getAccount(SUB)).username, "grace");
  });
});
