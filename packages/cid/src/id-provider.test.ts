import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { idClientFor } from "./id-clients.ts";
import { loadOidcSigner, signerFromJwk, verifyOidcToken } from "./oidc-sign.ts";
import { safeProductReturn } from "./product-idp.ts";

describe("shared product clients", () => {
  it("accepts each product origin and rejects a lookalike", () => {
    assert.ok(idClientFor("cumulus-cloud", "https://drive.cumuluscloud.app/files"));
    assert.ok(idClientFor("cumulus-cloud", "https://mail.cumuluscloud.app/"));
    assert.ok(idClientFor("cumulus-mail", "https://mail.cumuluscloud.app/inbox"));
    assert.ok(idClientFor("scalvs", "https://ru.scalvs.app/account"));
    assert.ok(idClientFor("cndctr", "https://cndctr.app/api/auth/callback"));
    assert.ok(idClientFor("fabric", "https://infinitumfabric.app/api/auth/callback"));
    assert.ok(idClientFor("defense", "https://infinitumdefense.com/"));
    assert.equal(idClientFor("scalvs", "https://scalvs.app.evil.example/"), null);
    assert.equal(idClientFor("cndctr", "http://cndctr.app/"), null);
    assert.equal(idClientFor("toString", "https://scalvs.app/"), null);
  });

  it("lets Infinitum developers sign in on developer.infinitumcorporation.ai only", () => {
    assert.ok(idClientFor("developer", "https://developer.infinitumcorporation.ai/"));
    assert.equal(idClientFor("developer", "https://infinitumcorporation.ai/"), null);
    assert.equal(idClientFor("developer", "http://developer.infinitumcorporation.ai/"), null);
    assert.equal(idClientFor("infinitum", "https://developer.infinitumcorporation.ai/"), null);
  });

  it("lets internal tools return to a loopback port, and nobody else", () => {
    assert.ok(idClientFor("1mind", "http://127.0.0.1:4400/auth/cid/callback"));
    assert.ok(idClientFor("conjure", "http://localhost:4317/auth/cid/callback"));
    assert.ok(idClientFor("eidetic-admin", "http://127.0.0.1:43112/"));
    assert.ok(idClientFor("eidetic-reviewer", "http://localhost:43111/"));
    assert.equal(idClientFor("1mind", "http://127.0.0.1/auth/cid/callback"), null, "a port is required");
    assert.equal(idClientFor("1mind", "http://evil.example:4400/"), null);
    assert.equal(idClientFor("1mind", "https://127.0.0.1:4400/"), null);
    assert.equal(idClientFor("scalvs", "http://127.0.0.1:8080/"), null, "public products never return to loopback");
    assert.ok(idClientFor("architect", "https://ldhkkbpfacheloapjlgnalmbaciameec.chromiumapp.org/"));
  });

  it("allows a product return that carries an https redirect in the query", () => {
    const next = "/api/id/authorize?redirect_uri=" + encodeURIComponent("https://scalvs.app/signed-in");
    assert.equal(safeProductReturn(next), next);
    assert.equal(safeProductReturn("//evil.example/api/id/authorize"), null);
    assert.equal(safeProductReturn("/api/id/../auth"), null);
    assert.equal(safeProductReturn("https://evil.example/api/id/authorize"), null);
  });
});

describe("OIDC signing key", () => {
  it("stays off when the secret is missing or unusable", () => {
    assert.equal(loadOidcSigner(undefined), null);
    assert.equal(loadOidcSigner("  "), null);
    assert.equal(loadOidcSigner("not-json"), null);
    assert.equal(loadOidcSigner(JSON.stringify({ kty: "oct", k: "aa" })), null);
  });

  it("signs and verifies without putting the private key in the JWKS", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const key = signerFromJwk({ ...privateKey.export({ format: "jwk" }), kid: "k" });
    const token = key.sign({ iss: "https://id.example/realms/cumulus", sub: "cid_1", aud: "scalvs", exp: Math.floor(Date.now() / 1000) + 60 });
    const claims = verifyOidcToken(token, key, { issuer: "https://id.example/realms/cumulus", now: new Date(), audience: "scalvs" });
    assert.equal(claims.sub, "cid_1");
    assert.equal(key.publicJwk().d, undefined);
    assert.equal(JSON.stringify(key.publicJwk()).includes('"d"'), false);
  });
});
