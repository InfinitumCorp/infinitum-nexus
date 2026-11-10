/**
 * Cumulus://ID access tokens for the SCALVS runtime.
 *
 * The issuer is fixed. Signing keys come from that issuer's discovery
 * document (jwks_uri), and the JWKS URL must stay on the issuer. Callers
 * can pass fetchImpl so tests never contact the real issuer.
 */
import { createPublicKey, verify, type webcrypto } from "node:crypto";

// @types/node 26 exposes JsonWebKey only under webcrypto.
type JsonWebKey = webcrypto.JsonWebKey;

export const CUMULUS_ISSUER = "https://id.cumuluscloud.app/realms/cumulus";
export const DEFAULT_AUDIENCE = "scalvs";

const DISCOVERY_URL = `${CUMULUS_ISSUER}/.well-known/openid-configuration`;
const AUDIENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function readAudience(raw: string | undefined): string {
  const value = raw?.trim() ?? "";
  if (value === "") return DEFAULT_AUDIENCE;
  if (!AUDIENCE_PATTERN.test(value)) throw new Error("SCALVS_AUDIENCE must be 1-128 letters, digits, or . _ : -");
  return value;
}

export interface CumulusAuthOptions {
  audience?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

interface RsaJwk extends JsonWebKey {
  kid?: string;
}

class TokenRejected extends Error {}
class KeysUnavailable extends Error {}

export interface CumulusAuth {
  audience: string;
  authenticate(authorization: string | undefined): Promise<void>;
}

export function createCumulusAuth(options: CumulusAuthOptions = {}): CumulusAuth {
  const audience = options.audience ?? DEFAULT_AUDIENCE;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  let cached: RsaJwk[] | undefined;
  let loading: Promise<RsaJwk[]> | undefined;

  function loadKeys(refresh: boolean): Promise<RsaJwk[]> {
    if (!refresh && cached) return Promise.resolve(cached);
    if (!refresh && loading) return loading;
    const run = discover(fetchImpl).then((keys) => {
      cached = keys;
      return keys;
    });
    if (refresh) return run;
    loading = run.finally(() => {
      loading = undefined;
    });
    return loading;
  }

  return {
    audience,
    async authenticate(authorization: string | undefined): Promise<void> {
      const token = bearer(authorization);
      if (!token) throw new TokenRejected();
      const parts = token.split(".");
      if (parts.length !== 3) throw new TokenRejected();
      const [encodedHeader, encodedClaims, encodedSignature] = parts;
      let header: { alg?: unknown; kid?: unknown };
      try {
        header = decodePart(encodedHeader) as { alg?: unknown; kid?: unknown };
      } catch {
        throw new TokenRejected();
      }
      if (header.alg !== "RS256") throw new TokenRejected();
      const kid = typeof header.kid === "string" ? header.kid : undefined;
      let keys: RsaJwk[];
      try {
        keys = await loadKeys(false);
      } catch {
        throw new KeysUnavailable();
      }
      let jwk = selectKey(keys, kid);
      if (!jwk) {
        try {
          keys = await loadKeys(true);
        } catch {
          throw new KeysUnavailable();
        }
        jwk = selectKey(keys, kid);
      }
      if (!jwk || !signatureMatches(encodedHeader, encodedClaims, encodedSignature, jwk)) throw new TokenRejected();

      let claims: Record<string, unknown>;
      try {
        claims = decodePart(encodedClaims) as Record<string, unknown>;
      } catch {
        throw new TokenRejected();
      }
      const seconds = Math.floor(now().getTime() / 1000);
      if (claims.iss !== CUMULUS_ISSUER) throw new TokenRejected();
      if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= seconds) throw new TokenRejected();
      if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf) || claims.nbf > seconds)) {
        throw new TokenRejected();
      }
      const audiences = typeof claims.aud === "string" ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud : [];
      if (!audiences.includes(audience)) throw new TokenRejected();
    },
  };
}

export function isKeysUnavailable(err: unknown): boolean {
  return err instanceof KeysUnavailable;
}

function bearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

function decodePart(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

function selectKey(keys: RsaJwk[], kid: string | undefined): RsaJwk | undefined {
  if (kid) return keys.find((key) => key.kid === kid);
  return keys.length === 1 ? keys[0] : undefined;
}

function signatureMatches(header: string, claims: string, signature: string, jwk: RsaJwk): boolean {
  if (typeof jwk.n !== "string" || typeof jwk.e !== "string") return false;
  try {
    const key = createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
    return verify("sha256", Buffer.from(`${header}.${claims}`), key, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

async function discover(fetchImpl: typeof fetch): Promise<RsaJwk[]> {
  const document = await getJson(fetchImpl, DISCOVERY_URL);
  const jwksUri = document && typeof document === "object" ? (document as { jwks_uri?: unknown }).jwks_uri : undefined;
  if (typeof jwksUri !== "string" || !jwksUrlAllowed(jwksUri)) throw new KeysUnavailable();
  const body = await getJson(fetchImpl, jwksUri);
  const keys = body && typeof body === "object" ? (body as { keys?: unknown }).keys : undefined;
  if (!Array.isArray(keys)) throw new KeysUnavailable();
  const rsa = keys.filter((key): key is RsaJwk => {
    if (!key || typeof key !== "object") return false;
    const jwk = key as RsaJwk;
    return jwk.kty === "RSA" && typeof jwk.n === "string" && typeof jwk.e === "string" && (jwk.use === undefined || jwk.use === "sig");
  });
  if (rsa.length === 0) throw new KeysUnavailable();
  return rsa;
}

function jwksUrlAllowed(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const issuer = new URL(CUMULUS_ISSUER);
  return url.protocol === "https:"
    && url.origin === issuer.origin
    && url.username === ""
    && url.password === ""
    && (url.pathname === issuer.pathname || url.pathname.startsWith(`${issuer.pathname}/`));
}

async function getJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const response = await fetchImpl(url, {
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new KeysUnavailable();
  const text = await response.text();
  if (text.length > 1_000_000) throw new KeysUnavailable();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new KeysUnavailable();
  }
}
