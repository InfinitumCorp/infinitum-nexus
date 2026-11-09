import { createHash, randomBytes, sign, webcrypto } from "node:crypto";
import { verifyIdToken, type IdTokenClaims } from "./oidc.ts";

type JsonWebKey = webcrypto.JsonWebKey;

/**
 * Social sign-in for Cumulus://ID: Google, Microsoft, Apple and Sign in with ChatGPT
 * (OpenID Connect) and GitHub (OAuth 2.0). Every flow uses the authorization-code grant
 * with PKCE, a single-use state and (for OIDC) a nonce bound into the ID token.
 */

export type SocialProviderId = "google" | "github" | "microsoft" | "apple" | "chatgpt";

export interface SocialCredentials {
  clientId: string;
  /** Client secret. For Apple, leave empty and supply `apple` key details instead. */
  clientSecret?: string;
  /** Apple: generates the ES256 client-secret JWT Apple requires. */
  apple?: { teamId: string; keyId: string; privateKeyPem: string };
  /** OIDC providers whose endpoints come from discovery (Sign in with ChatGPT). */
  issuer?: string;
}

export interface ProviderSpec {
  id: SocialProviderId;
  label: string;
  kind: "oidc" | "github";
  scopes: string[];
  authorizeUrl?: string;
  tokenUrl?: string;
  jwksUrl?: string;
  /** Exact issuer, or a check for multi-tenant issuers (Microsoft). */
  issuer?: string;
  issuerCheck?: (iss: string, claims: IdTokenClaims) => boolean;
  /** Apple posts the result back as a form. */
  responseMode?: "form_post";
  /** Endpoints found through OpenID discovery at the configured issuer. */
  discover?: boolean;
}

export const PROVIDERS: Record<SocialProviderId, ProviderSpec> = {
  google: {
    id: "google",
    label: "Google",
    kind: "oidc",
    scopes: ["openid", "email", "profile"],
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
    issuerCheck: (iss) => iss === "https://accounts.google.com" || iss === "accounts.google.com",
  },
  microsoft: {
    id: "microsoft",
    label: "Microsoft",
    kind: "oidc",
    scopes: ["openid", "email", "profile"],
    authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    jwksUrl: "https://login.microsoftonline.com/common/discovery/v2.0/keys",
    // Multi-tenant: the issuer names the user's tenant, which must match the token's tid claim.
    issuerCheck: (iss, c) => typeof c.tid === "string" && iss === `https://login.microsoftonline.com/${c.tid}/v2.0`,
  },
  apple: {
    id: "apple",
    label: "Apple",
    kind: "oidc",
    scopes: ["name", "email"],
    authorizeUrl: "https://appleid.apple.com/auth/authorize",
    tokenUrl: "https://appleid.apple.com/auth/token",
    jwksUrl: "https://appleid.apple.com/auth/keys",
    issuer: "https://appleid.apple.com",
    responseMode: "form_post",
  },
  chatgpt: {
    id: "chatgpt",
    label: "ChatGPT",
    kind: "oidc",
    scopes: ["openid", "email", "profile"],
    // OpenAI's partner beta: endpoints are read from the issuer's discovery document.
    discover: true,
  },
  github: {
    id: "github",
    label: "GitHub",
    kind: "github",
    scopes: ["read:user", "user:email"],
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
  },
};

export interface SocialProfile {
  provider: SocialProviderId;
  subject: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
  /** Suggested username (GitHub login or email local part). */
  usernameHint?: string;
}

export interface PendingAuth {
  state: string;
  provider: SocialProviderId;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  expiresAt: number;
  /** Set when a signed-in person is linking a provider to their existing CID. */
  linkToCid?: string;
}

const b64u = (b: Buffer) => b.toString("base64url");

export function pkcePair() {
  const verifier = b64u(randomBytes(32));
  const challenge = b64u(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** Apple requires a short-lived ES256 JWT as the client secret. */
export function appleClientSecret(creds: SocialCredentials, now: Date): string {
  if (!creds.apple) throw new Error("Apple sign-in needs teamId, keyId and privateKeyPem");
  const iat = Math.floor(now.getTime() / 1000);
  const header = { alg: "ES256", kid: creds.apple.keyId };
  const payload = { iss: creds.apple.teamId, iat, exp: iat + 300, aud: "https://appleid.apple.com", sub: creds.clientId };
  const enc = (o: unknown) => b64u(Buffer.from(JSON.stringify(o)));
  const data = `${enc(header)}.${enc(payload)}`;
  return `${data}.${b64u(sign("sha256", Buffer.from(data), { key: creds.apple.privateKeyPem, dsaEncoding: "ieee-p1363" }))}`;
}

const issuerKey = (issuer: string) => issuer.replace(/\/$/, "");

export class SocialClient {
  private readonly fetchImpl: typeof fetch;
  private readonly jwksCache = new Map<string, { keys: (JsonWebKey & { kid?: string })[]; at: number }>();
  private readonly discoveryCache = new Map<string, { authorization_endpoint: string; token_endpoint: string; jwks_uri: string; issuer: string }>();

  constructor(fetchImpl: typeof fetch = fetch) {
    this.fetchImpl = fetchImpl;
  }

  private async json<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchImpl(url, init);
    const text = await res.text();
    if (!res.ok) throw new Error(`${new URL(url).host} returned ${res.status}`);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`${new URL(url).host} returned an unreadable response`);
    }
  }

  async endpoints(spec: ProviderSpec, creds: SocialCredentials) {
    if (!spec.discover) {
      return { authorize: spec.authorizeUrl!, token: spec.tokenUrl!, jwks: spec.jwksUrl, issuer: spec.issuer };
    }
    if (!creds.issuer) throw new Error(`${spec.label} sign-in needs its issuer URL configured`);
    const configured = issuerKey(creds.issuer);
    let d = this.discoveryCache.get(configured);
    if (!d) {
      d = await this.json(`${configured}/.well-known/openid-configuration`);
      if (issuerKey(d!.issuer) !== configured) throw new Error(`${spec.label} discovery issuer mismatch`);
      this.discoveryCache.set(configured, d!);
    }
    return { authorize: d!.authorization_endpoint, token: d!.token_endpoint, jwks: d!.jwks_uri, issuer: d!.issuer };
  }

  async authorizeUrl(spec: ProviderSpec, creds: SocialCredentials, pending: PendingAuth, codeChallenge: string) {
    const ep = await this.endpoints(spec, creds);
    const u = new URL(ep.authorize);
    u.searchParams.set("client_id", creds.clientId);
    u.searchParams.set("redirect_uri", pending.redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", spec.scopes.join(" "));
    u.searchParams.set("state", pending.state);
    u.searchParams.set("code_challenge", codeChallenge);
    u.searchParams.set("code_challenge_method", "S256");
    if (spec.kind === "oidc") u.searchParams.set("nonce", pending.nonce);
    if (spec.responseMode) u.searchParams.set("response_mode", spec.responseMode);
    if (spec.id === "google") u.searchParams.set("prompt", "select_account");
    if (spec.id === "github") u.searchParams.set("allow_signup", "true");
    return u.toString();
  }

  private async jwks(url: string, kid: string | undefined, now: number) {
    const cached = this.jwksCache.get(url);
    const fresh = cached && now - cached.at < 3_600_000 && (!kid || cached.keys.some((k) => k.kid === kid));
    if (fresh) return cached!.keys;
    // Unknown key id = the provider rotated keys; refetch.
    const { keys } = await this.json<{ keys: (JsonWebKey & { kid?: string })[] }>(url);
    this.jwksCache.set(url, { keys, at: now });
    return keys;
  }

  /** Exchange the authorization code and return the verified profile. */
  async complete(spec: ProviderSpec, creds: SocialCredentials, pending: PendingAuth, code: string, now: Date): Promise<SocialProfile> {
    const ep = await this.endpoints(spec, creds);
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: pending.redirectUri,
      client_id: creds.clientId,
      code_verifier: pending.codeVerifier,
    });
    const secret = spec.id === "apple" ? appleClientSecret(creds, now) : creds.clientSecret;
    if (secret) form.set("client_secret", secret);
    const tokens = await this.json<{ id_token?: string; access_token?: string; error?: string; error_description?: string }>(ep.token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form.toString(),
    });
    if (tokens.error) throw new Error(`${spec.label}: ${tokens.error_description ?? tokens.error}`);

    if (spec.kind === "github") {
      if (!tokens.access_token) throw new Error("GitHub didn't return an access token");
      const headers = { authorization: `Bearer ${tokens.access_token}`, accept: "application/vnd.github+json", "user-agent": "Infinitum-CID" };
      const user = await this.json<{ id: number; login: string; name?: string }>("https://api.github.com/user", { headers });
      const emails = await this.json<{ email: string; primary: boolean; verified: boolean }[]>("https://api.github.com/user/emails", { headers }).catch(() => []);
      const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
      return { provider: "github", subject: String(user.id), email: primary?.email, emailVerified: Boolean(primary), name: user.name ?? undefined, usernameHint: user.login };
    }

    if (!tokens.id_token) throw new Error(`${spec.label} didn't return an ID token`);
    const header = JSON.parse(Buffer.from(tokens.id_token.split(".")[0] ?? "", "base64url").toString("utf8") || "{}") as { kid?: string };
    const keys = await this.jwks(ep.jwks!, header.kid, now.getTime());
    // Issuer is checked below so multi-tenant issuers (Microsoft) can be validated precisely.
    const claims = verifyIdToken(tokens.id_token, { issuer: "*", audience: creds.clientId, jwks: keys }, { now, nonce: pending.nonce, skipIssuer: true });
    const issuerOk = spec.issuerCheck ? spec.issuerCheck(claims.iss, claims) : claims.iss === (ep.issuer ?? spec.issuer);
    if (!issuerOk) throw new Error(`${spec.label}: token issuer not accepted`);
    const emailVerified = claims.email_verified === true || (claims.email_verified as unknown) === "true";
    return {
      provider: spec.id,
      subject: claims.sub,
      email: claims.email,
      emailVerified,
      name: typeof claims.name === "string" ? claims.name : undefined,
      usernameHint: claims.email?.split("@")[0] ?? (typeof claims.preferred_username === "string" ? claims.preferred_username.split("@")[0] : undefined),
    };
  }
}

/** Load social provider credentials from standard environment variables.
 *  Any product that uses Cumulus://ID can call this and pass the result to CidService.
 */
export function socialFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<Record<SocialProviderId, SocialCredentials>> {
  const social: Partial<Record<SocialProviderId, SocialCredentials>> = {};
  if (env.GOOGLE_CLIENT_ID) social.google = { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
  if (env.GITHUB_CLIENT_ID) social.github = { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET };
  if (env.MICROSOFT_CLIENT_ID) social.microsoft = { clientId: env.MICROSOFT_CLIENT_ID, clientSecret: env.MICROSOFT_CLIENT_SECRET };
  if (env.APPLE_CLIENT_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY) {
    social.apple = { clientId: env.APPLE_CLIENT_ID, apple: { teamId: env.APPLE_TEAM_ID, keyId: env.APPLE_KEY_ID, privateKeyPem: env.APPLE_PRIVATE_KEY.replace(/\\n/g, "\n") } };
  }
  if (env.CHATGPT_CLIENT_ID && env.CHATGPT_ISSUER) {
    social.chatgpt = { clientId: env.CHATGPT_CLIENT_ID, clientSecret: env.CHATGPT_CLIENT_SECRET, issuer: env.CHATGPT_ISSUER };
  }
  return social;
}
