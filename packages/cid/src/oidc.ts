import { createPublicKey, verify, webcrypto } from "node:crypto";

type JsonWebKey = webcrypto.JsonWebKey;

/**
 * Verifies OpenID Connect ID tokens from an organization's identity provider
 * (Okta, Microsoft Entra ID, Google Workspace, etc.) for CID single sign-on federation.
 */

export interface SsoConfig {
  issuer: string;
  /** The client ID registered with the identity provider. */
  audience: string;
  /** Provider signing keys (from its jwks_uri). */
  jwks: (JsonWebKey & { kid?: string })[];
}

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nbf?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  [k: string]: unknown;
}

const ALGS: Record<string, { hash: string | null; dsa?: "ieee-p1363" }> = {
  RS256: { hash: "sha256" },
  ES256: { hash: "sha256", dsa: "ieee-p1363" },
  EdDSA: { hash: null },
};

export function verifyIdToken(
  token: string,
  config: SsoConfig,
  options: { now: Date; nonce?: string; clockSkewSeconds?: number; /** Caller validates iss itself (multi-tenant issuers). */ skipIssuer?: boolean },
): IdTokenClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("SSO: malformed ID token");
  const [h, p, s] = parts;
  const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as { alg: string; kid?: string };
  const alg = ALGS[header.alg];
  if (!alg) throw new Error(`SSO: algorithm ${header.alg} not allowed`); // blocks "none" and HMAC confusion

  const jwk = config.jwks.find((k) => (header.kid ? k.kid === header.kid : true));
  if (!jwk) throw new Error("SSO: signing key not found");
  const { kid: _kid, ...keyMaterial } = jwk;
  const key = createPublicKey({ key: keyMaterial as any, format: "jwk" });
  const sig = Buffer.from(s, "base64url");
  const data = Buffer.from(`${h}.${p}`);
  const ok = alg.dsa ? verify(alg.hash, data, { key: key.export({ type: "spki", format: "der" }), format: "der", type: "spki", dsaEncoding: alg.dsa }, sig) : verify(alg.hash, data, key, sig);
  if (!ok) throw new Error("SSO: signature check failed");

  const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as IdTokenClaims;
  const now = Math.floor(options.now.getTime() / 1000);
  const skew = options.clockSkewSeconds ?? 60;
  if (!options.skipIssuer && claims.iss !== config.issuer) throw new Error("SSO: wrong issuer");
  if (typeof claims.iss !== "string" || !claims.iss) throw new Error("SSO: token has no issuer");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(config.audience)) throw new Error("SSO: token not issued for Infinitum");
  if (typeof claims.exp !== "number" || claims.exp + skew < now) throw new Error("SSO: token expired");
  if (claims.nbf !== undefined && claims.nbf - skew > now) throw new Error("SSO: token not yet valid");
  if (options.nonce !== undefined && claims.nonce !== options.nonce) throw new Error("SSO: nonce mismatch");
  if (!claims.sub) throw new Error("SSO: token has no subject");
  return claims;
}
