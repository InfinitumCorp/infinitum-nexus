import { CidService, verifyOidcToken, type OidcAlg, type OidcPublicJwk, type OidcSigner } from "@infinitum/cid";

/** Cumulus://Cloud is its own CID app so Drive access can be revoked without touching Mail. */
export const DRIVE_APP = "cumulus-cloud";

export interface DrivePrincipal {
  cid: string;
  sessionId: string;
}

export interface DriveAuth {
  authenticate(token: string): DrivePrincipal | null | Promise<DrivePrincipal | null>;
  can(cid: string, scope: "drive:read" | "drive:write"): boolean | Promise<boolean>;
  grantDrive(cid: string): Promise<void>;
}

/** Adapts a real Cumulus://ID service. The caller never supplies the CID in the body. */
export function cidAuth(cid: CidService): DriveAuth {
  return {
    async authenticate(token: string): Promise<DrivePrincipal | null> {
      const hit = await cid.authenticate(token);
      if (!hit) return null;
      return { cid: hit.account.cid, sessionId: hit.session.id };
    },
    async can(id: string, scope: "drive:read" | "drive:write"): Promise<boolean> {
      return await cid.can(id, DRIVE_APP, scope);
    },
    async grantDrive(id: string): Promise<void> {
      await cid.grant(id, DRIVE_APP, ["drive:read", "drive:write"]);
    },
  };
}

/* ------------------------------------------------------------------ *
 * Cumulus://ID issuer tokens
 * ------------------------------------------------------------------ */

export interface IssuerAuthOptions {
  /** Realm issuer, e.g. https://id.cumuluscloud.app/realms/cumulus (the `iss` in every token). */
  issuer: string;
  /** Client id the token must be issued to. Default cumulus-cloud. */
  audience?: string;
  /** JWKS URL. Default <issuer>/protocol/openid-connect/certs. */
  jwksUri?: string;
  fetchImpl?: typeof fetch;
  clock?: () => Date;
  /** How long fetched keys are trusted before a refresh. Default 10 minutes. */
  keysTtlMs?: number;
}

const CID_SUB = /^cid_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
/** An unknown key id refetches the JWKS at most this often, so junk tokens can't hammer the issuer. */
const MISS_REFETCH_MS = 30_000;

/** A verify-only key: verifyOidcToken needs alg, kid and the public JWK. */
function verifierFor(jwk: OidcPublicJwk): OidcSigner {
  return {
    alg: jwk.alg,
    kid: jwk.kid,
    publicJwk: () => jwk,
    sign: () => {
      throw new Error("verify-only key");
    },
  };
}

function usableKey(k: unknown): k is OidcPublicJwk {
  const j = k as Record<string, unknown> | null;
  if (!j || typeof j !== "object" || typeof j.kid !== "string" || !j.kid || j.d !== undefined) return false;
  if (j.use !== undefined && j.use !== "sig") return false;
  const alg = j.alg as OidcAlg;
  if (alg === "ES256") return j.kty === "EC" && j.crv === "P-256" && typeof j.x === "string" && typeof j.y === "string";
  if (alg === "EdDSA") return j.kty === "OKP" && j.crv === "Ed25519" && typeof j.x === "string";
  return false;
}

/**
 * Drive accepts access tokens signed by the Cumulus://ID issuer (id.cumuluscloud.app), so a person's
 * one Cumulus://ID works here without Cloud keeping accounts or sessions of its own.
 *
 * A token must be signed by a key in the issuer's JWKS, carry this issuer, be issued to `audience`
 * (cumulus-cloud), be unexpired, and name a cid as its subject. Tokens live at most one hour; Drive
 * can't see a sign-out at the issuer until the token expires. The issuer only mints a cumulus-cloud
 * token after recording the person's grant for that client, so `can` follows from the audience.
 */
export function issuerAuth(opts: IssuerAuthOptions): DriveAuth {
  const issuer = opts.issuer.replace(/\/$/, "");
  const iss = new URL(issuer);
  const local = iss.hostname === "localhost" || iss.hostname === "127.0.0.1";
  if (iss.protocol !== "https:" && !local) throw new Error("The Cumulus://ID issuer must be an https URL");
  const audience = opts.audience ?? "cumulus-cloud";
  const jwksUri = opts.jwksUri ?? `${issuer}/protocol/openid-connect/certs`;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const clock = opts.clock ?? (() => new Date());
  const ttl = opts.keysTtlMs ?? 10 * 60_000;

  let keys = new Map<string, OidcSigner>();
  let fetchedAt = -Infinity;
  let lastMiss = -Infinity;
  let inflight: Promise<void> | null = null;

  const refresh = () =>
    (inflight ??= (async () => {
      try {
        const res = await fetchImpl(jwksUri, { redirect: "manual", signal: AbortSignal.timeout(5_000), headers: { accept: "application/json" } });
        if (!res.ok) return; // keep the keys we have
        const body = (await res.json().catch(() => null)) as { keys?: unknown } | null;
        if (!body || !Array.isArray(body.keys)) return;
        const next = new Map<string, OidcSigner>();
        for (const k of body.keys) if (usableKey(k)) next.set(k.kid, verifierFor(k));
        keys = next;
        fetchedAt = clock().getTime();
      } catch {
        // Issuer unreachable: keep the keys we have.
      } finally {
        inflight = null;
      }
    })());

  const keyFor = async (kid: string): Promise<OidcSigner | undefined> => {
    const now = clock().getTime();
    if (now - fetchedAt > ttl) await refresh();
    let key = keys.get(kid);
    if (!key && now - lastMiss > MISS_REFETCH_MS) {
      lastMiss = now;
      await refresh(); // the issuer may have rotated its key
      key = keys.get(kid);
    }
    return key;
  };

  return {
    async authenticate(token: string): Promise<DrivePrincipal | null> {
      if (token.length > 8_000 || !JWT.test(token)) return null;
      let kid: unknown;
      try {
        kid = (JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString("utf8")) as { kid?: unknown }).kid;
      } catch {
        return null;
      }
      if (typeof kid !== "string" || !kid || kid.length > 200) return null;
      const key = await keyFor(kid);
      if (!key) return null;
      let claims: Record<string, unknown>;
      try {
        claims = verifyOidcToken(token, key, { issuer, audience, now: clock(), clockSkewSeconds: 30 });
      } catch {
        return null;
      }
      const sub = claims.sub;
      if (typeof sub !== "string" || !CID_SUB.test(sub) || (claims.cid !== undefined && claims.cid !== sub)) return null;
      const sid = typeof claims.sid === "string" && claims.sid ? claims.sid : `jwt:${typeof claims.jti === "string" ? claims.jti : sub}`;
      return { cid: sub, sessionId: sid };
    },
    can(): boolean {
      return true;
    },
    async grantDrive(): Promise<void> {
      // The grant lives at the issuer; it was recorded when the token was issued.
    },
  };
}
