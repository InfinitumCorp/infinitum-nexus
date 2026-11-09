import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { test } from "node:test";
import { CndctrAuthError, verifyCndctrToken } from "./auth.ts";

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
  return { iss: issuer, sub: "user-1", aud: "cndctr", exp: now + 300, iat: now, preferred_username: "William", ...extra };
}

test("accepts a Cumulus ID token and a Keycloak azp audience", () => {
  const identity = verifyCndctrToken(token(claims()), { issuer, audience: "cndctr", jwks: [jwk] });
  assert.equal(identity.username, "william");
  assert.equal(identity.sub, "user-1");
  const access = verifyCndctrToken(token(claims({ aud: "account", azp: "cndctr" })), { issuer, audience: "cndctr", jwks: [jwk] });
  assert.equal(access.username, "william");
});

test("rejects none, bad signatures, issuer, audience, and expiry", () => {
  const now = Math.floor(Date.now() / 1000);
  const good = token(claims());
  const [h, p, s] = good.split(".");
  const sig = Buffer.from(s ?? "", "base64url");
  sig[0] = (sig[0] ?? 0) ^ 0xff;
  const flipped = `${h}.${p}.${sig.toString("base64url")}`;
  assert.throws(() => verifyCndctrToken(token(claims(), { alg: "none", kid: "k1" }), { issuer, audience: "cndctr", jwks: [jwk] }), (error: CndctrAuthError) => error.code === "alg");
  assert.throws(() => verifyCndctrToken(token(claims(), { alg: "HS256", kid: "k1" }), { issuer, audience: "cndctr", jwks: [jwk] }), (error: CndctrAuthError) => error.code === "alg");
  assert.throws(() => verifyCndctrToken(flipped, { issuer, audience: "cndctr", jwks: [jwk] }), (error: CndctrAuthError) => error.code === "signature");
  assert.throws(() => verifyCndctrToken(token(claims({ iss: "https://evil.example" })), { issuer, audience: "cndctr", jwks: [jwk] }), (error: CndctrAuthError) => error.code === "issuer");
  assert.throws(() => verifyCndctrToken(token(claims({ aud: "account", azp: "other" })), { issuer, audience: "cndctr", jwks: [jwk] }), (error: CndctrAuthError) => error.code === "audience");
  assert.throws(() => verifyCndctrToken(token(claims({ exp: now - 120 })), { issuer, audience: "cndctr", jwks: [jwk] }), (error: CndctrAuthError) => error.code === "expired");
  assert.throws(() => verifyCndctrToken(token(claims({ nonce: "nope" })), { issuer, audience: "cndctr", jwks: [jwk], nonce: "expected" }), (error: CndctrAuthError) => error.code === "nonce");
});
