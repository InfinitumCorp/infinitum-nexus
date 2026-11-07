import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { test } from "node:test";
import { FabricAuthError, verifyFabricToken } from "./auth.ts";

const issuer = "https://id.cumuluscloud.app/realms/cumulus";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };

function token(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: "k1", typ: "JWT" }, key: KeyObject = privateKey): string {
  const h = Buffer.from(JSON.stringify(header)).toString("base64url");
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
  if (header.alg === "none") return `${h}.${p}.bm90`;
  const signature = sign("sha256", Buffer.from(`${h}.${p}`), key).toString("base64url");
  return `${h}.${p}.${signature}`;
}

function claims(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return { iss: issuer, sub: "user-1", aud: "fabric", exp: now + 300, iat: now, preferred_username: "Alice", ...extra };
}

test("accepts a Cumulus ID token and a Keycloak azp audience", () => {
  const identity = verifyFabricToken(token(claims()), { issuer, audience: "fabric", jwks: [jwk] });
  assert.equal(identity.username, "alice");
  assert.equal(identity.sub, "user-1");
  const access = verifyFabricToken(token(claims({ aud: "account", azp: "fabric" })), { issuer, audience: "fabric", jwks: [jwk] });
  assert.equal(access.username, "alice");
});

test("rejects none, bad signatures, issuer, audience, and expiry", () => {
  const now = Math.floor(Date.now() / 1000);
  const good = token(claims());
  const flipped = `${good.slice(0, -1)}${good.endsWith("a") ? "b" : "a"}`;
  assert.throws(() => verifyFabricToken(token(claims(), { alg: "none", kid: "k1" }), { issuer, audience: "fabric", jwks: [jwk] }), (error: FabricAuthError) => error.code === "alg");
  assert.throws(() => verifyFabricToken(token(claims(), { alg: "HS256", kid: "k1" }), { issuer, audience: "fabric", jwks: [jwk] }), (error: FabricAuthError) => error.code === "alg");
  assert.throws(() => verifyFabricToken(flipped, { issuer, audience: "fabric", jwks: [jwk] }), (error: FabricAuthError) => error.code === "signature" || error.code === "malformed");
  assert.throws(() => verifyFabricToken(token(claims({ iss: "https://evil.example" })), { issuer, audience: "fabric", jwks: [jwk] }), (error: FabricAuthError) => error.code === "issuer");
  assert.throws(() => verifyFabricToken(token(claims({ aud: "account", azp: "other" })), { issuer, audience: "fabric", jwks: [jwk] }), (error: FabricAuthError) => error.code === "audience");
  assert.throws(() => verifyFabricToken(token(claims({ exp: now - 120 })), { issuer, audience: "fabric", jwks: [jwk] }), (error: FabricAuthError) => error.code === "expired");
  assert.throws(() => verifyFabricToken(token(claims({ nonce: "nope" })), { issuer, audience: "fabric", jwks: [jwk], nonce: "expected" }), (error: FabricAuthError) => error.code === "nonce");
});
