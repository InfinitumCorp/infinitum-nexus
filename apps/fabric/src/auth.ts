/**
 * Cumulus://ID Keycloak JWT verification.
 * Accepts RS256, ES256, and EdDSA. HMAC and "none" are rejected.
 */
import { createPublicKey, verify, type webcrypto } from "node:crypto";

// @types/node 26 exposes JsonWebKey only under webcrypto.
type JsonWebKey = webcrypto.JsonWebKey;

export interface Jwk {
  kid?: string;
  alg?: string;
  use?: string;
  kty?: string;
  crv?: string;
  n?: string;
  e?: string;
  x?: string;
  y?: string;
  d?: string;
  k?: string;
}

export interface FabricIdentity {
  sub: string;
  issuer: string;
  username: string;
  email: string | null;
  name: string | null;
  expiresAt: number;
}

export class FabricAuthError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "FabricAuthError";
    this.code = code;
  }
}

const ALGS: Record<string, { hash: string | null; dsa?: "ieee-p1363"; kty: string; crv?: string }> = {
  RS256: { hash: "sha256", kty: "RSA" },
  ES256: { hash: "sha256", dsa: "ieee-p1363", kty: "EC", crv: "P-256" },
  EdDSA: { hash: null, kty: "OKP", crv: "Ed25519" },
};

const USERNAME = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/;

export function verifyFabricToken(
  token: string,
  options: { issuer: string; audience: string; jwks: Jwk[]; now?: Date; clockSkewSeconds?: number; nonce?: string },
): FabricIdentity {
  if (typeof token !== "string" || token.length < 20 || token.length > 16_384) throw new FabricAuthError("malformed");
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) throw new FabricAuthError("malformed");
  const [h, p, s] = parts as [string, string, string];
  const header = parseJson(h);
  if (!header || typeof header !== "object" || Array.isArray(header)) throw new FabricAuthError("malformed");
  const algName = header.alg;
  const kid = header.kid;
  if (typeof algName !== "string" || typeof kid !== "string" || kid.length === 0 || kid.length > 128) throw new FabricAuthError("malformed");
  if (header.crit !== undefined) throw new FabricAuthError("alg");
  const alg = ALGS[algName];
  if (!alg) throw new FabricAuthError("alg");
  const jwk = options.jwks.find((key) => key.kid === kid && (key.alg === undefined || key.alg === algName) && (key.use === undefined || key.use === "sig"));
  if (!jwk || jwk.d !== undefined || jwk.kty !== alg.kty) throw new FabricAuthError("key");
  if (alg.crv && jwk.crv !== alg.crv) throw new FabricAuthError("key");
  const key = createPublicKey({ key: publicMaterial(jwk), format: "jwk" });
  const data = Buffer.from(`${h}.${p}`);
  const sig = Buffer.from(s, "base64url");
  const ok = alg.dsa
    ? verify(alg.hash, data, { key, dsaEncoding: alg.dsa }, sig)
    : verify(alg.hash, data, key, sig);
  if (!ok) throw new FabricAuthError("signature");

  const claims = parseJson(p);
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) throw new FabricAuthError("malformed");
  if (claims.iss !== options.issuer) throw new FabricAuthError("issuer");
  if (!audienceMatches(claims.aud, claims.azp, options.audience)) throw new FabricAuthError("audience");
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const skew = options.clockSkewSeconds ?? 60;
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp + skew < now) throw new FabricAuthError("expired");
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf - skew > now)) throw new FabricAuthError("expired");
  if (typeof claims.iat === "number" && claims.iat - skew > now) throw new FabricAuthError("expired");
  if (options.nonce !== undefined && claims.nonce !== options.nonce) throw new FabricAuthError("nonce");
  if (typeof claims.sub !== "string" || claims.sub.length < 1 || claims.sub.length > 255 || /[\u0000-\u001f\u007f]/.test(claims.sub)) {
    throw new FabricAuthError("subject");
  }
  const username = usernameFrom(claims.preferred_username, claims.sub);
  return {
    sub: claims.sub,
    issuer: options.issuer,
    username,
    email: typeof claims.email === "string" && EMAIL.test(claims.email) ? claims.email.toLowerCase() : null,
    name: cleanName(claims.name),
    expiresAt: claims.exp,
  };
}

export function isPublicSigningKey(value: unknown): value is Jwk {
  if (!value || typeof value !== "object") return false;
  const key = value as Jwk;
  if (key.d !== undefined || key.k !== undefined) return false;
  if (key.use !== undefined && key.use !== "sig") return false;
  if (typeof key.kid !== "string" || key.kid.length === 0) return false;
  return key.kty === "RSA" || key.kty === "EC" || key.kty === "OKP";
}

function audienceMatches(aud: unknown, azp: unknown, audience: string): boolean {
  const values = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud : [];
  if (values.some((value) => value === audience)) return true;
  return azp === audience;
}

function usernameFrom(preferred: unknown, sub: string): string {
  if (typeof preferred === "string" && USERNAME.test(preferred.trim().toLowerCase())) return preferred.trim().toLowerCase();
  const compact = sub.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 48);
  const derived = `cid${compact || "user"}`.slice(0, 64);
  if (!USERNAME.test(derived)) throw new FabricAuthError("subject");
  return derived;
}

function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!name || name.length > 120) return null;
  return name;
}

function publicMaterial(jwk: Jwk): JsonWebKey {
  if (jwk.kty === "RSA" && jwk.n && jwk.e) return { kty: "RSA", n: jwk.n, e: jwk.e };
  if (jwk.kty === "EC" && jwk.crv && jwk.x && jwk.y) return { kty: "EC", crv: jwk.crv, x: jwk.x, y: jwk.y };
  if (jwk.kty === "OKP" && jwk.crv && jwk.x) return { kty: "OKP", crv: jwk.crv, x: jwk.x };
  throw new FabricAuthError("key");
}

function parseJson(part: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}
