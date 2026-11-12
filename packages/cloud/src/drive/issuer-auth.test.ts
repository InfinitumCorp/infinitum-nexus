/**
 * Drive accepts Cumulus://ID access tokens. The tokens here come from the real issuer code
 * (registerProductIdp in @infinitum/cid, which id.cumuluscloud.app serves) through a small route
 * harness: authorize with PKCE, then trade the code at the token endpoint.
 */
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CidService, registerProductIdp, signerFromJwk, type OidcSigner } from "@infinitum/cid";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { issuerAuth } from "./auth.ts";

class Redirect {
  location: string;
  constructor(location: string) {
    this.location = location;
  }
}
class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function oidcKey(kid: string): OidcSigner {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return signerFromJwk({ ...privateKey.export({ format: "jwk" }), kid });
}

/** The issuer: a CidService plus registerProductIdp, with its handlers called directly. */
function issuer(signer: OidcSigner) {
  const s = generateSigner();
  const cid = new CidService({ ledger: new Ledger(undefined, { authorizedSigners: [s.publicKey] }), signer: s, rpId: "id.cumuluscloud.app", origins: ["https://id.cumuluscloud.app"] });
  const routes = new Map<string, (ctx: any) => unknown>();
  registerProductIdp({
    route: (method, path, handler) => void routes.set(`${method} ${path}`, handler),
    cid, origin: "https://id.cumuluscloud.app", device: () => "test", need: () => {}, Redirect, HttpError, signer,
  });
  const res = { setHeader() {} };
  /** Full product sign-in for `client`; returns the access token the product receives. */
  const tokenFor = async (username: string, client = "cumulus-cloud", redirect = "https://drive.cumuluscloud.app/signed-in") => {
    const account = cid.store.byUsername.get(username) ? cid.getAccount(cid.store.byUsername.get(username)!) : await cid.createAccount({ username });
    const { session } = await (cid as any).issueSession(account.cid, "browser", "passkey");
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const query = new URLSearchParams({ client_id: client, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "s" });
    const back = (await routes.get("GET /api/id/authorize")!({ query, user: { account, sessionId: session.id }, req: { headers: {} }, res })) as Redirect;
    const code = new URL(back.location).searchParams.get("code")!;
    const out = (await routes.get("POST /api/id/token")!({ body: { code, code_verifier: verifier, client_id: client, redirect_uri: redirect }, req: { headers: {} }, res })) as { access_token: string };
    return { token: out.access_token, cid: account.cid, sessionId: session.id };
  };
  return { cid, tokenFor };
}

/** The issuer's JWKS endpoint, with a call counter. */
function jwks(keys: () => OidcSigner[]) {
  const calls = { n: 0 };
  const fetchImpl = (async (url: string | URL | Request) => {
    calls.n++;
    assert.match(String(url), /\/realms\/cumulus\/protocol\/openid-connect\/certs$/);
    return Response.json({ keys: keys().map((k) => k.publicJwk()) });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const ISSUER = "https://id.cumuluscloud.app/realms/cumulus";

describe("Drive accepts Cumulus://ID access tokens", () => {
  it("signs in with a token the issuer minted for cumulus-cloud", async () => {
    const key = oidcKey("k1");
    const id = issuer(key);
    const { fetchImpl } = jwks(() => [key]);
    const auth = issuerAuth({ issuer: ISSUER, fetchImpl });
    const { token, cid } = await id.tokenFor("alex");
    const who = await auth.authenticate(token);
    assert.equal(who?.cid, cid);
    assert.ok(who?.sessionId.startsWith("ses_"));
    assert.equal(await auth.can(cid, "drive:write"), true);
  });

  it("refuses tokens for another product, from another issuer, expired, or signed by an unknown key", async () => {
    const key = oidcKey("k1");
    const id = issuer(key);
    let now = new Date();
    const auth = issuerAuth({ issuer: ISSUER, fetchImpl: jwks(() => [key]).fetchImpl, clock: () => now });

    const scalvs = await id.tokenFor("sam", "scalvs", "https://scalvs.app/");
    assert.equal(await auth.authenticate(scalvs.token), null, "audience scalvs is not Drive");

    const ok = await id.tokenFor("sam");
    const elsewhere = issuerAuth({ issuer: "https://id.cumuluscloud.app/realms/other", fetchImpl: jwks(() => [key]).fetchImpl, jwksUri: `${ISSUER}/protocol/openid-connect/certs` });
    assert.equal(await elsewhere.authenticate(ok.token), null, "issuer must match");

    // A forger with their own key, even reusing the real kid.
    const forger = oidcKey("k1");
    const [h, p] = ok.token.split(".");
    const forged = forger.sign(JSON.parse(Buffer.from(p!, "base64url").toString()));
    assert.notEqual(forged.split(".")[0], undefined);
    assert.equal(await auth.authenticate(forged), null, "signature must verify");
    // alg none / tampered payload.
    const none = `${Buffer.from(JSON.stringify({ alg: "none", kid: "k1" })).toString("base64url")}.${p}.x`;
    assert.equal(await auth.authenticate(none), null);
    const claims = JSON.parse(Buffer.from(p!, "base64url").toString());
    const tampered = `${h}.${Buffer.from(JSON.stringify({ ...claims, sub: "cid_00000000-0000-4000-8000-000000000000", cid: "cid_00000000-0000-4000-8000-000000000000" })).toString("base64url")}.${ok.token.split(".")[2]}`;
    assert.equal(await auth.authenticate(tampered), null, "payload can't be swapped");

    assert.equal((await auth.authenticate(ok.token))?.cid, ok.cid);
    now = new Date(now.getTime() + 2 * 60 * 60_000);
    assert.equal(await auth.authenticate(ok.token), null, "expired after an hour");

    for (const junk of ["", "abc", "a.b", "a.b.c", "x".repeat(9000)]) assert.equal(await auth.authenticate(junk), null);
  });

  it("follows a key rotation, but an unknown kid can't make it hammer the issuer", async () => {
    let active = [oidcKey("old")];
    const { fetchImpl, calls } = jwks(() => active);
    let now = new Date();
    const auth = issuerAuth({ issuer: ISSUER, fetchImpl, clock: () => now });
    const first = issuer(active[0]!);
    assert.ok(await auth.authenticate((await first.tokenFor("kim")).token));
    assert.equal(calls.n, 1, "keys are cached");
    assert.ok(await auth.authenticate((await first.tokenFor("kim")).token));
    assert.equal(calls.n, 1);

    // The issuer rotates to a new key: the first token with the new kid refetches once.
    const rotated = oidcKey("new");
    active = [rotated];
    const second = issuer(rotated);
    assert.ok(await auth.authenticate((await second.tokenFor("kim")).token));
    assert.equal(calls.n, 2);

    // Junk kids: at most one refetch per 30 s window (the rotation above used the current one).
    for (let i = 0; i < 5; i++) assert.equal(await auth.authenticate(oidcKey("nobody").sign({ iss: ISSUER, sub: "cid_00000000-0000-4000-8000-000000000000", aud: "cumulus-cloud", exp: Math.floor(Date.now() / 1000) + 60 })), null);
    assert.equal(calls.n, 2, "no refetch inside the window");
    now = new Date(now.getTime() + 31_000);
    const stranger = oidcKey("nobody").sign({ iss: ISSUER, sub: "cid_00000000-0000-4000-8000-000000000000", aud: "cumulus-cloud", exp: Math.floor(Date.now() / 1000) + 60 });
    for (let i = 0; i < 20; i++) assert.equal(await auth.authenticate(stranger), null);
    assert.equal(calls.n, 3);
    now = new Date(now.getTime() + 31_000);
    assert.equal(await auth.authenticate(stranger), null);
    assert.equal(calls.n, 4);
  });

  it("stops trusting a key the issuer withdrew once the cache expires", async () => {
    const compromised = oidcKey("k1");
    const id = issuer(compromised);
    let published = [compromised];
    let now = new Date();
    const auth = issuerAuth({ issuer: ISSUER, fetchImpl: jwks(() => published).fetchImpl, clock: () => now });
    const { token } = await id.tokenFor("ray");
    assert.ok(await auth.authenticate(token));
    published = [oidcKey("k2")]; // the issuer withdraws k1
    now = new Date(now.getTime() + 11 * 60_000); // past the 10-minute key cache, token still unexpired
    assert.equal(await auth.authenticate(token), null);
  });

  it("keeps working on cached keys when the issuer is down, and refuses an http issuer", async () => {
    const key = oidcKey("k1");
    const id = issuer(key);
    let up = true;
    let now = new Date();
    const auth = issuerAuth({
      issuer: ISSUER, clock: () => now,
      fetchImpl: (async () => { if (!up) throw new Error("down"); return Response.json({ keys: [key.publicJwk()] }); }) as typeof fetch,
    });
    const { token } = await id.tokenFor("lee");
    assert.ok(await auth.authenticate(token));
    up = false;
    now = new Date(now.getTime() + 11 * 60_000); // past the key TTL: refresh fails, cached key stays
    assert.ok(await auth.authenticate((await id.tokenFor("lee")).token));
    assert.throws(() => issuerAuth({ issuer: "http://id.cumuluscloud.app/realms/cumulus" }));
  });
});
