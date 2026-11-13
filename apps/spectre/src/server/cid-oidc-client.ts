import { createHash, randomBytes, type webcrypto } from "node:crypto";
import { verifyIdToken, type IdTokenClaims } from "@infinitum/cid";

/**
 * +SPCTR as an OpenID Connect client of the standalone Cumulus://ID issuer
 * (InfinitumCorp/cumulus-id). Public client: no secret, every code exchange bound by PKCE S256.
 *
 * Off by default. SPECTRE_AUTH=oidc turns it on at cut-over; unset, +SPCTR keeps signing people
 * in with the in-process CID (passkeys, MFA, social sign-in) exactly as before.
 */

export const DEFAULT_CID_ISSUER = "https://id.cumuluscloud.app/realms/cumulus";
export const DEFAULT_CID_CLIENT_ID = "spectre";

export interface OidcClientConfig {
  /** Issuer URL, e.g. https://id.cumuluscloud.app/realms/cumulus. */
  issuer: string;
  /** Client id registered at the issuer (src/clients.ts in cumulus-id). */
  clientId: string;
  /** Tests inject a fake issuer here. */
  fetch?: typeof fetch;
  /** Tests: clock for ID token expiry. */
  now?: () => Date;
}

/** SPECTRE_AUTH=oidc → client config from CID_ISSUER / CID_CLIENT_ID; anything else → null (in-process CID). */
export function oidcClientFromEnv(env: Record<string, string | undefined>): OidcClientConfig | null {
  const mode = (env.SPECTRE_AUTH ?? "").trim().toLowerCase();
  if (mode !== "oidc") return null;
  return {
    issuer: (env.CID_ISSUER?.trim() || DEFAULT_CID_ISSUER).replace(/\/$/, ""),
    clientId: env.CID_CLIENT_ID?.trim() || DEFAULT_CID_CLIENT_ID,
  };
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
  revocation_endpoint?: string;
}

type Jwk = webcrypto.JsonWebKey & { kid?: string };

export class OidcClientError extends Error {}

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const random = () => b64u(randomBytes(32));
const DISCOVERY_TTL_MS = 60 * 60_000;

export function createOidcClient(config: OidcClientConfig) {
  const issuer = config.issuer.replace(/\/$/, "");
  const doFetch = config.fetch ?? fetch;
  const now = config.now ?? (() => new Date());
  let discovery: { doc: Discovery; at: number } | null = null;
  let jwks: Jwk[] | null = null;

  const getJson = async (url: string) => {
    const res = await doFetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new OidcClientError(`Cumulus://ID answered ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  };

  const httpsUrl = (v: unknown, name: string) => {
    if (typeof v !== "string") throw new OidcClientError(`Cumulus://ID discovery has no ${name}`);
    const u = new URL(v);
    if (u.protocol !== "https:") throw new OidcClientError(`Cumulus://ID ${name} is not https`);
    return v;
  };

  async function discover(): Promise<Discovery> {
    if (discovery && Date.now() - discovery.at < DISCOVERY_TTL_MS) return discovery.doc;
    const doc = await getJson(`${issuer}/.well-known/openid-configuration`);
    if (doc.issuer !== issuer) throw new OidcClientError("Cumulus://ID discovery names a different issuer");
    const parsed: Discovery = {
      issuer,
      authorization_endpoint: httpsUrl(doc.authorization_endpoint, "authorization_endpoint"),
      token_endpoint: httpsUrl(doc.token_endpoint, "token_endpoint"),
      jwks_uri: httpsUrl(doc.jwks_uri, "jwks_uri"),
      end_session_endpoint: doc.end_session_endpoint ? httpsUrl(doc.end_session_endpoint, "end_session_endpoint") : undefined,
      revocation_endpoint: doc.revocation_endpoint ? httpsUrl(doc.revocation_endpoint, "revocation_endpoint") : undefined,
    };
    discovery = { doc: parsed, at: Date.now() };
    return parsed;
  }

  async function keys(kid: string | undefined, refresh: boolean): Promise<Jwk[]> {
    if (!jwks || refresh || (kid && !jwks.some((k) => k.kid === kid))) {
      const body = await getJson((await discover()).jwks_uri);
      if (!Array.isArray(body.keys)) throw new OidcClientError("Cumulus://ID JWKS has no keys");
      jwks = body.keys as Jwk[];
    }
    return jwks;
  }

  return {
    issuer,
    clientId: config.clientId,

    /** Authorization request with PKCE S256, state and nonce. The caller keeps state/nonce/verifier. */
    async authorize(opts: { redirectUri: string; prompt?: "create" | "login" }) {
      const { authorization_endpoint } = await discover();
      const state = random();
      const nonce = random();
      const verifier = random();
      const challenge = b64u(createHash("sha256").update(verifier).digest());
      const url = new URL(authorization_endpoint);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: config.clientId,
        redirect_uri: opts.redirectUri,
        scope: "openid profile email",
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: "S256",
        ...(opts.prompt ? { prompt: opts.prompt } : {}),
      }).toString();
      return { url: url.toString(), state, nonce, verifier };
    },

    /** Exchanges the code at the token endpoint and verifies the ID token (signature, iss, aud, exp, nonce). */
    async finish(opts: { code: string; verifier: string; redirectUri: string; nonce: string }): Promise<{ claims: IdTokenClaims; idToken: string }> {
      const { token_endpoint } = await discover();
      const res = await doFetch(token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: opts.code,
          redirect_uri: opts.redirectUri,
          client_id: config.clientId,
          code_verifier: opts.verifier,
        }).toString(),
      });
      const body = (await res.json().catch(() => ({}))) as { id_token?: unknown };
      if (!res.ok || typeof body.id_token !== "string") throw new OidcClientError("Cumulus://ID didn't complete the sign-in");
      const idToken = body.id_token;
      let header: { alg?: string; kid?: string };
      try {
        header = JSON.parse(Buffer.from(idToken.split(".")[0] ?? "", "base64url").toString("utf8")) as { alg?: string; kid?: string };
      } catch {
        throw new OidcClientError("Cumulus://ID returned a malformed ID token");
      }
      // Cumulus://ID signs with ES256 only; anything else is not its token.
      if (header.alg !== "ES256") throw new OidcClientError("Cumulus://ID ID tokens are ES256");
      const kid = header.kid;
      const verify = async (refresh: boolean) =>
        verifyIdToken(idToken, { issuer, audience: config.clientId, jwks: await keys(kid, refresh) }, { now: now(), nonce: opts.nonce });
      let claims: IdTokenClaims;
      try {
        claims = await verify(false);
      } catch (err) {
        // A rotated key the cache doesn't have yet: fetch the JWKS once more, then give up.
        if (!(err instanceof Error) || !/signing key not found|signature check failed/.test(err.message)) throw new OidcClientError((err as Error).message);
        try {
          claims = await verify(true);
        } catch (again) {
          throw new OidcClientError((again as Error).message);
        }
      }
      // A token for several audiences must name this client as the authorized party.
      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if ((aud.length > 1 || claims.azp !== undefined) && claims.azp !== config.clientId) throw new OidcClientError("SSO: token not issued for +SPCTR");
      if (claims.cid !== undefined && claims.cid !== claims.sub) throw new OidcClientError("SSO: cid and sub differ");
      return { claims, idToken };
    },

    /** Where to send the browser after the local session ends; null when the issuer has no logout endpoint. */
    async logoutUrl(opts: { postLogoutRedirectUri: string; idTokenHint?: string }): Promise<string | null> {
      const { end_session_endpoint } = await discover();
      if (!end_session_endpoint) return null;
      const url = new URL(end_session_endpoint);
      url.search = new URLSearchParams({
        client_id: config.clientId,
        post_logout_redirect_uri: opts.postLogoutRedirectUri,
        ...(opts.idTokenHint ? { id_token_hint: opts.idTokenHint } : {}),
      }).toString();
      return url.toString();
    },

    /** Account page at the issuer, where passkeys, MFA and linked accounts are managed. */
    accountUrl() {
      return `${new URL(issuer).origin}/account`;
    },
  };
}

export type OidcClient = ReturnType<typeof createOidcClient>;
