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
