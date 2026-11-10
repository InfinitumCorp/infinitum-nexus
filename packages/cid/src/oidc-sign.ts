/**
 * Signs Cumulus://ID OpenID Connect tokens.
 *
 * The private key is the Worker secret CID_OIDC_SIGNING_KEY: a JWK JSON document, either
 * ES256 (P-256) or EdDSA (Ed25519). When the secret is missing or unusable, callers get
 * null and leave OpenID Connect off. Passkey, Google and Cognito sign-in do not need it.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject, type webcrypto } from "node:crypto";

// @types/node 26 exposes JsonWebKey only under webcrypto.
type JsonWebKey = webcrypto.JsonWebKey;

export type OidcAlg = "ES256" | "EdDSA";

export interface OidcPublicJwk extends JsonWebKey {
  kid: string;
  alg: OidcAlg;
  use: "sig";
}

export interface OidcSigner {
  readonly alg: OidcAlg;
  readonly kid: string;
  publicJwk(): OidcPublicJwk;
  sign(claims: Record<string, unknown>): string;
}

const b64u = (b: Buffer) => b.toString("base64url");

function thumbprint(parts: Record<string, string>): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("base64url").slice(0, 16);
}

function publicMaterial(jwk: OidcPublicJwk): JsonWebKey {
  if (jwk.kty === "EC") return { kty: "EC", crv: jwk.crv, x: jwk.x, y: jwk.y };
  return { kty: "OKP", crv: jwk.crv, x: jwk.x };
}

function signer(alg: OidcAlg, kid: string, privateKey: KeyObject, publicJwk: OidcPublicJwk): OidcSigner {
  return {
    alg,
    kid,
    publicJwk: () => ({ ...publicJwk }),
    sign(claims) {
      const header = { alg, kid, typ: "JWT" };
      const data = `${b64u(Buffer.from(JSON.stringify(header)))}.${b64u(Buffer.from(JSON.stringify(claims)))}`;
      const sig = alg === "ES256"
        ? sign("sha256", Buffer.from(data), { key: privateKey, dsaEncoding: "ieee-p1363" })
        : sign(null, Buffer.from(data), privateKey);
      return `${data}.${b64u(sig)}`;
    },
  };
}

/** Build a signer from a private JWK. Throws when the key is not ES256 or Ed25519. */
export function signerFromJwk(input: JsonWebKey & { kid?: string }): OidcSigner {
  if (input.kty === "EC" && input.crv === "P-256" && input.d && input.x && input.y) {
    const kid = input.kid || thumbprint({ crv: "P-256", kty: "EC", x: input.x, y: input.y });
    const privateKey = createPrivateKey({ key: { kty: "EC", crv: "P-256", x: input.x, y: input.y, d: input.d }, format: "jwk" });
    return signer("ES256", kid, privateKey, { kty: "EC", crv: "P-256", x: input.x, y: input.y, kid, alg: "ES256", use: "sig" });
  }
  if (input.kty === "OKP" && input.crv === "Ed25519" && input.d && input.x) {
    const kid = input.kid || thumbprint({ crv: "Ed25519", kty: "OKP", x: input.x });
    const privateKey = createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", x: input.x, d: input.d }, format: "jwk" });
    return signer("EdDSA", kid, privateKey, { kty: "OKP", crv: "Ed25519", x: input.x, kid, alg: "EdDSA", use: "sig" });
  }
  throw new Error("CID_OIDC_SIGNING_KEY must be an ES256 P-256 or EdDSA Ed25519 private JWK");
}

/**
 * Read CID_OIDC_SIGNING_KEY. An empty value turns OpenID Connect off.
 * A value that is not a usable private JWK also turns it off, and the key material is not logged.
 */
export function loadOidcSigner(raw: string | undefined): OidcSigner | null {
  const text = raw?.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as JsonWebKey;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    return signerFromJwk(parsed);
  } catch {
    console.error("CID_OIDC_SIGNING_KEY is set but cannot be used. OpenID Connect stays off. Existing sign-in is unchanged.");
    return null;
  }
}

/** Verify a token this signer produced. Rejects a bad signature, issuer, audience or expiry. */
export function verifyOidcToken(
  token: string,
  key: OidcSigner,
  options: { issuer: string; now: Date; audience?: string; clockSkewSeconds?: number },
): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) throw new Error("malformed");
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: unknown; kid?: unknown; crit?: unknown };
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as { alg?: unknown; kid?: unknown };
  } catch {
    throw new Error("malformed");
  }
  if (header.crit !== undefined) throw new Error("alg");
  if (header.alg !== key.alg || header.kid !== key.kid) throw new Error("key");
  const jwk = key.publicJwk();
  if (jwk.d !== undefined) throw new Error("key");
  const data = Buffer.from(`${h}.${p}`);
  const sig = Buffer.from(s, "base64url");
  let ok = false;
  try {
    const cryptoKey = createPublicKey({ key: publicMaterial(jwk), format: "jwk" });
    ok = key.alg === "ES256"
      ? verify("sha256", data, { key: cryptoKey, dsaEncoding: "ieee-p1363" }, sig)
      : verify(null, data, cryptoKey, sig);
  } catch {
    ok = false;
  }
  if (!ok) throw new Error("signature");
  let claims: Record<string, unknown>;
  try {
    const parsed = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("malformed");
    claims = parsed as Record<string, unknown>;
  } catch {
    throw new Error("malformed");
  }
  const now = Math.floor(options.now.getTime() / 1000);
  const skew = options.clockSkewSeconds ?? 60;
  if (claims.iss !== options.issuer) throw new Error("issuer");
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp + skew < now) throw new Error("expired");
  if (typeof claims.sub !== "string" || !claims.sub) throw new Error("subject");
  if (options.audience !== undefined) {
    const aud = typeof claims.aud === "string" ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud : [];
    if (!aud.includes(options.audience)) throw new Error("audience");
  }
  return claims;
}
