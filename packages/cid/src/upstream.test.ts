import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { CidService, CidError, UpstreamIdClient, UpstreamIdError, parseUpstreamProfile, upstreamIssuerFromEnv } from "./index.ts";

const ISSUER = "https://id.cumuluscloud.app";
const DOMAIN = "cumuluscloud.app";
const CID_A = "cid_0b8f3c2e-4d1a-4f6e-9a7b-2c3d4e5f6a7b";
const CID_B = "cid_1c9a4d3f-5e2b-4a7f-8b8c-3d4e5f6a7b8c";
const profile = (cid: string, username: string) => ({ cid, username, email: `${username}@${DOMAIN}`, handle: `@${username}.veil` });

function service(upstreamIssuer?: string) {
  const signer = generateSigner();
  const ledger = new Ledger(undefined, { authorizedSigners: [signer.publicKey] });
  const events: string[] = [];
  const cid = new CidService({
    ledger, signer, rpId: "mail.cumuluscloud.app", origins: ["https://mail.cumuluscloud.app"], upstreamIssuer,
    onEvent: (e) => { events.push(`${e.event}:${e.cid}`); },
  });
  return { cid, ledger, events };
}

describe("upstream mode: one issuer, local mirrors keep the issuer's cid", () => {
  it("never mints a cid of its own", async () => {
    const { cid } = service(ISSUER);
    await assert.rejects(cid.createAccount({ username: "alex" }), (e: CidError) => e.code === "signup_at_issuer");
  });

  it("adopts an issuer account under the same cid, provisions it once, and signs it in", async () => {
    const { cid, ledger, events } = service(ISSUER);
    const first = await cid.adoptUpstreamAccount(profile(CID_A, "alex"), "Browser");
    assert.equal(first.created, true);
    assert.equal(first.session.cid, CID_A);
    assert.equal(first.session.method, "cumulus-id");
    const account = await cid.getAccount(CID_A);
    assert.equal(account.mailAddress, "alex@cumuluscloud.app");
    assert.equal(account.upstream?.issuer, ISSUER);
    assert.equal((await cid.authenticate(first.token))?.account.cid, CID_A);
    assert.deepEqual(events.filter((e) => e.startsWith("account.created")), [`account.created:${CID_A}`]);

    const again = await cid.adoptUpstreamAccount(profile(CID_A, "alex"), "Phone");
    assert.equal(again.created, false);
    assert.equal(events.filter((e) => e.startsWith("account.created")).length, 1);
    const adopted = (await ledger.query({ product: "cid", subject: CID_A })).map((e) => e.payload.event);
    assert.ok(adopted.includes("account.adopted"));
  });

  it("never merges a pre-cutover local account that holds the same username", async () => {
    const legacy = service();
    const old = await legacy.cid.createAccount({ username: "sam" });
    // Same store, now switched to upstream mode (what a redeploy with CUMULUS_ID_ISSUER does).
    const signer = generateSigner();
    const cid = new CidService({ ledger: new Ledger(undefined, { authorizedSigners: [signer.publicKey] }), signer, rpId: "mail.cumuluscloud.app", origins: ["https://mail.cumuluscloud.app"], store: legacy.cid.store, upstreamIssuer: ISSUER });
    await assert.rejects(cid.adoptUpstreamAccount(profile(CID_B, "sam"), "Browser"), (e: CidError) => e.code === "username_conflict");
    assert.equal(cid.store.byUsername.get("sam"), old.cid);
    assert.equal(cid.store.accounts.has(CID_B), false);
  });

  it("refuses a cid whose stored username differs, and malformed profiles", async () => {
    const { cid } = service(ISSUER);
    await cid.adoptUpstreamAccount(profile(CID_A, "alex"), "Browser");
    await assert.rejects(cid.adoptUpstreamAccount(profile(CID_A, "mallory"), "Browser"), (e: CidError) => e.code === "username_conflict");
    await assert.rejects(cid.adoptUpstreamAccount({ ...profile(CID_B, "kim"), email: "kim@evil.example" }, "Browser"), (e: CidError) => e.code === "bad_profile");
    await assert.rejects(cid.adoptUpstreamAccount(profile("cid_../../x", "kim"), "Browser"), (e: CidError) => e.code === "bad_profile");
  });

  it("is off unless configured", async () => {
    const { cid } = service();
    await assert.rejects(cid.adoptUpstreamAccount(profile(CID_A, "alex"), "Browser"), (e: CidError) => e.code === "upstream_off");
    assert.equal(upstreamIssuerFromEnv({}), undefined);
    assert.equal(upstreamIssuerFromEnv({ CUMULUS_ID_ISSUER: "https://id.cumuluscloud.app/" }), ISSUER);
    assert.throws(() => upstreamIssuerFromEnv({ CUMULUS_ID_ISSUER: "http://id.cumuluscloud.app" }));
    assert.throws(() => upstreamIssuerFromEnv({ CUMULUS_ID_ISSUER: "https://id.cumuluscloud.app/realms/cumulus" }));
  });
});

describe("UpstreamIdClient", () => {
  const client = (fetchImpl: typeof fetch) =>
    new UpstreamIdClient({ issuer: ISSUER, clientId: "cumulus-mail", redirectUri: "https://mail.cumuluscloud.app/api/auth/cid/callback", mailDomain: DOMAIN, fetchImpl });

  it("starts a PKCE request and trades the code at the issuer, then drops the issuer token", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    let challenge = "";
    const c = client(async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/api/id/token")) {
        const body = JSON.parse(String(init!.body));
        assert.equal(createHash("sha256").update(body.code_verifier).digest("base64url"), challenge);
        assert.equal(body.client_id, "cumulus-mail");
        assert.equal(body.redirect_uri, "https://mail.cumuluscloud.app/api/auth/cid/callback");
        return Response.json({ access_token: "issuer-token", profile: profile(CID_A, "alex") });
      }
      return Response.json({ ok: true });
    });
    const { url, cookie } = c.start({ create: true });
    const u = new URL(url);
    assert.equal(u.origin + u.pathname, `${ISSUER}/api/id/authorize`);
    assert.equal(u.searchParams.get("prompt"), "create");
    assert.equal(u.searchParams.get("code_challenge_method"), "S256");
    challenge = u.searchParams.get("code_challenge")!;
    const got = await c.finish({ code: "a".repeat(43), state: u.searchParams.get("state"), cookie });
    assert.deepEqual(got, profile(CID_A, "alex"));
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.init!.redirect, "manual");
    assert.equal(calls[1]!.url, `${ISSUER}/api/id/signout`);
    assert.equal(new Headers(calls[1]!.init!.headers).get("authorization"), "Bearer issuer-token");
  });

  it("rejects a state that wasn't started in this browser, without calling the issuer", async () => {
    let called = false;
    const c = client(async () => { called = true; return Response.json({}); });
    const { cookie } = c.start();
    const other = c.start();
    await assert.rejects(c.finish({ code: "a".repeat(43), state: new URL(other.url).searchParams.get("state"), cookie }), (e: UpstreamIdError) => e.code === "challenge_expired");
    await assert.rejects(c.finish({ code: "a".repeat(43), state: "x", cookie: undefined }), (e: UpstreamIdError) => e.code === "challenge_expired");
    assert.equal(called, false);
  });

  it("treats redirects, errors and odd profiles from the token endpoint as failures", async () => {
    const run = async (reply: Response) => {
      const c = client(async () => reply);
      const { url, cookie } = c.start();
      return c.finish({ code: "a".repeat(43), state: new URL(url).searchParams.get("state"), cookie });
    };
    await assert.rejects(run(new Response(null, { status: 302, headers: { location: "https://evil.example/" } })), (e: UpstreamIdError) => e.code === "upstream_refused");
    await assert.rejects(run(Response.json({ error: "nope" }, { status: 400 })), (e: UpstreamIdError) => e.code === "upstream_refused");
    await assert.rejects(run(Response.json({ profile: { ...profile(CID_A, "alex"), email: "alex@gmail.com" } })), (e: UpstreamIdError) => e.code === "bad_profile");
    assert.throws(() => parseUpstreamProfile({ cid: CID_A, username: "A" }, DOMAIN));
  });
});
