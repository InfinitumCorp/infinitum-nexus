/**
 * "Sign in with Cumulus://ID" (OAuth 2.0 authorization code + PKCE, RFC 7636).
 *
 * id.cumuluscloud.app is the issuer. mail.cumuluscloud.app registers the same routes without a
 * signing key, so buttons that already call Mail keep receiving an opaque session token.
 *
 *   1. GET /api/id/authorize?...     Not signed in yet: the sign-in page opens, then this continues.
 *   2. Redirect to redirect_uri?code&state.
 *   3. POST /api/id/token { code, code_verifier, client_id } -> { access_token, profile }.
 *      When CID_OIDC_SIGNING_KEY is set, access_token and id_token are signed JWTs and sub is the cid.
 *   4. GET /api/id/userinfo with Authorization: Bearer. POST /api/id/signout ends that session.
 *
 * The same authorize and token handlers also serve the OpenID Connect paths under
 * /realms/cumulus/protocol/openid-connect/ when a signer is configured.
 */
import type { Account, CidService } from "./service.ts";
import { idClientFor, idClientOrigins } from "./id-clients.ts";
import type { OidcSigner } from "./oidc-sign.ts";
import { verifyOidcToken } from "./oidc-sign.ts";
import { answerLabyrinthDirectory, labyrinthDirectoryKeyMatches, LabyrinthDirectoryError } from "./labyrinth-directory.ts";
import { exportCidAccounts } from "./account-export.ts";

export const profileOf = (a: Account) => ({ cid: a.cid, username: a.username, email: a.mailAddress, name: a.username, handle: a.handle });

/** A same-origin path back into this sign-in, or null. Used after Google or Cognito. */
export function safeProductReturn(value: string | null | undefined): string | null {
  if (!value || value.length > 3500) return null;
  if (!value.startsWith("/api/id/") && !value.startsWith("/realms/cumulus/")) return null;
  if (value.startsWith("//") || value.includes("\\") || /[\u0000\r\n]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value, "https://id.cumuluscloud.app");
  } catch {
    return null;
  }
  if (url.origin !== "https://id.cumuluscloud.app" || url.username || url.password) return null;
  if (!url.pathname.startsWith("/api/id/") && !url.pathname.startsWith("/realms/cumulus/")) return null;
  return url.pathname + url.search;
}

export function oidcDiscovery(issuer: string, alg: string) {
  const realm = issuer.replace(/\/$/, "");
  return {
    issuer: realm,
    authorization_endpoint: `${realm}/protocol/openid-connect/auth`,
    token_endpoint: `${realm}/protocol/openid-connect/token`,
    userinfo_endpoint: `${realm}/protocol/openid-connect/userinfo`,
    jwks_uri: `${realm}/protocol/openid-connect/certs`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: [alg],
    scopes_supported: ["openid", "profile", "email"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    claims_supported: ["sub", "cid", "username", "preferred_username", "handle", "email", "email_verified", "amr", "idp", "nonce"],
  };
}

export interface ProductIdpHelpers {
  route: (method: string, path: string, handler: (ctx: any) => unknown, auth?: boolean, opts?: { csrf?: boolean; optionalAuth?: boolean }) => void;
  cid: CidService;
  origin: string;
  sessionCookie?: (token: string, maxAge?: number) => string;
  device: (ctx: any) => string;
  need: (ctx: any, ...fields: string[]) => void;
  str?: (v: unknown, max?: number) => string;
  Redirect: new (location: string) => unknown;
  HttpError: new (status: number, message: string) => Error;
  /** When null or omitted, tokens stay opaque and the OpenID Connect routes are not registered. */
  signer?: OidcSigner | null;
  /**
   * SHA-256 (hex) of the service key a separately hosted Labyrinth uses to reach
   * POST /api/id/labyrinth-directory. Unset: the route is not registered.
   */
  labyrinthDirectoryKeySha256?: string;
  /**
   * SHA-256 (hex) of the one-off key for POST /api/id/export, the account export used to move
   * Cumulus://ID to InfinitumCorp/cumulus-id. Unset (the default): the route is not registered.
   */
  exportKeySha256?: string;
}

const ALL_ORIGINS = idClientOrigins();
const OPAQUE = /^[A-Za-z0-9_-]{20,200}$/;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const ACCESS_TTL_S = 60 * 60;

function idpOfMethod(method: string | undefined): string {
  if (!method) return "passkey";
  if (method.startsWith("social:")) {
    const id = method.slice("social:".length).split("+")[0] ?? "";
    return /^[a-z0-9_-]{1,32}$/.test(id) ? id : "passkey";
  }
  if (method === "passkey" || method === "security-key" || method.startsWith("passkey")) return "passkey";
  if (method === "sso") return "sso";
  return "passkey";
}

function emailClaims(account: Account): { email: string; email_verified: boolean } {
  // attachIdentity stores an address only after the provider says it is verified.
  const linked = account.identities?.find((i) => i.email);
  if (linked?.email) return { email: linked.email, email_verified: true };
  // The mailbox is one we issued with the CID.
  return { email: account.mailAddress, email_verified: true };
}

export function registerProductIdp(h: ProductIdpHelpers) {
  const { route, cid, Redirect, HttpError } = h;
  const signer = h.signer ?? null;
  const str = h.str ?? ((v: unknown, max = 8000) => String(v ?? "").slice(0, max));
  const cors = (ctx: any) => {
    const o = ctx.req.headers.origin;
    if (typeof o === "string" && ALL_ORIGINS.has(o)) {
      ctx.res.setHeader("Access-Control-Allow-Origin", o);
      ctx.res.setHeader("Vary", "Origin");
    }
  };

  const accountFromToken = async (token: string) => {
    if (!token.includes(".")) {
      const hit = await cid.authenticate(token);
      if (!hit) throw new HttpError(401, "Not signed in");
      return { account: hit.account, sessionId: hit.session.id };
    }
    if (!signer) throw new HttpError(401, "Not signed in");
    let claims: Record<string, unknown>;
    try {
      claims = verifyOidcToken(token, signer, { issuer: cid.issuer, now: new Date() });
    } catch {
      throw new HttpError(401, "Not signed in");
    }
    if (typeof claims.sid !== "string" || claims.sub !== claims.cid) throw new HttpError(401, "Not signed in");
    const live = (await cid.listSessions(String(claims.sub))).some((s) => s.id === claims.sid);
    if (!live) throw new HttpError(401, "Not signed in");
    return { account: await cid.getAccount(String(claims.sub)), sessionId: claims.sid };
  };

  const presented = (ctx: any): string => {
    const header = /^Bearer\s+(\S+)$/.exec(String(ctx.req.headers.authorization ?? ""));
    const fromHeader = header?.[1] ?? "";
    const fromBody = typeof ctx.body?.access_token === "string" ? ctx.body.access_token : "";
    const token = fromHeader || fromBody;
    if ((OPAQUE.test(token) || JWT.test(token)) && token.length <= 8000) return token;
    throw new HttpError(401, "Not signed in");
  };

  const authorize = async (ctx: any, strict: boolean) => {
    const q = ctx.query as URLSearchParams;
    const clientId = str(q.get("client_id"), 40);
    const redirectUri = str(q.get("redirect_uri"), 500);
    const challenge = str(q.get("code_challenge"), 128);
    const state = str(q.get("state"), 200);
    const nonce = str(q.get("nonce"), 200);
    const client = idClientFor(clientId, redirectUri);
    if (!client) throw new HttpError(400, "This sign-in request didn't come from an Infinitum product.");
    const responseType = q.get("response_type");
    if (strict && responseType !== "code") throw new HttpError(400, "This sign-in request is missing its security check. Start again from the product.");
    if (responseType && responseType !== "code") throw new HttpError(400, "This sign-in request is missing its security check. Start again from the product.");
    const scope = q.get("scope");
    if (strict && scope && !scope.split(" ").includes("openid")) throw new HttpError(400, "This sign-in request is missing its security check. Start again from the product.");
    if ((q.get("code_challenge_method") ?? "S256") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
      throw new HttpError(400, "This sign-in request is missing its security check. Start again from the product.");
    }
    if (!ctx.user) {
      const back = `${strict ? "/realms/cumulus/protocol/openid-connect/auth" : "/api/id/authorize"}?${q.toString()}`;
      // "Create a Cumulus ID" in a product sends prompt=create: open the sign-in page on Create.
      const create = q.get("prompt") === "create" ? "&create=1" : "";
      return new Redirect(`/?next=${encodeURIComponent(back)}&for=${encodeURIComponent(client.name)}${create}`);
    }
    const account = ctx.user.account as Account;
    if (!(await cid.can(account.cid, client.app, "profile:read"))) await cid.grant(account.cid, client.app, ["profile:read"]);
    const idp = idpOfMethod((await cid.listSessions(account.cid)).find((s) => s.id === ctx.user.sessionId)?.method);
    const { code } = await cid.grantDeviceHandoff(account.cid, challenge, clientId, {
      idp,
      nonce: nonce || undefined,
      redirectUri,
    });
    const to = new URL(redirectUri);
    to.searchParams.set("code", code);
    if (state) to.searchParams.set("state", state);
    return new Redirect(to.toString());
  };

  route("GET", "/api/id/authorize", (ctx) => authorize(ctx, false), false, { optionalAuth: true });
  if (signer) {
    route("GET", "/realms/cumulus/protocol/openid-connect/auth", (ctx) => authorize(ctx, true), false, { optionalAuth: true });
  }

  const tokenResponse = (account: Account, session: { id: string; expiresAt: string }, clientId: string, idp: string, nonce: string | undefined, opaque: string) => {
    const profile = profileOf(account);
    const now = new Date();
    const remaining = Math.max(0, Math.floor((new Date(session.expiresAt).getTime() - now.getTime()) / 1000));
    if (!signer) return { access_token: opaque, token_type: "Bearer", expires_in: remaining, profile };
    const exp = Math.floor(now.getTime() / 1000) + Math.max(1, Math.min(ACCESS_TTL_S, remaining));
    const iat = Math.floor(now.getTime() / 1000);
    const email = emailClaims(account);
    const shared: Record<string, unknown> = {
      iss: cid.issuer,
      sub: account.cid,
      aud: clientId,
      iat,
      exp,
      cid: account.cid,
      username: account.username,
      preferred_username: account.username,
      handle: account.handle,
      email: email.email,
      email_verified: email.email_verified,
      amr: [idp],
      idp,
      azp: clientId,
    };
    const idClaims = { ...shared };
    if (nonce) idClaims.nonce = nonce;
    return {
      access_token: signer.sign({ ...shared, sid: session.id }),
      id_token: signer.sign(idClaims),
      token_type: "Bearer",
      expires_in: exp - iat,
      profile,
    };
  };

  const redeem = async (ctx: any, code: string, verifier: string, clientId: string, redirectUri?: string) => {
    const redeemed = await cid.redeemDeviceHandoff(str(code, 64), str(verifier, 128), h.device(ctx));
    if (redeemed.app !== clientId || (redirectUri && redeemed.redirectUri && redeemed.redirectUri !== redirectUri)) {
      await cid.revokeSession(redeemed.session.cid, redeemed.session.id);
      throw new HttpError(400, "That sign-in code belongs to another product.");
    }
    return tokenResponse(await cid.getAccount(redeemed.session.cid), redeemed.session, clientId, redeemed.idp, redeemed.nonce, redeemed.token);
  };

  const token = async (ctx: any, strict: boolean) => {
    cors(ctx);
    if (strict) {
      const body = ctx.body ?? {};
      if (str(body.grant_type, 40) !== "authorization_code") throw new HttpError(400, "That sign-in link expired. Start again from the app.");
      return redeem(ctx, body.code, body.code_verifier, str(body.client_id, 40), str(body.redirect_uri, 500));
    }
    h.need(ctx, "code", "code_verifier", "client_id");
    return redeem(ctx, ctx.body.code, ctx.body.code_verifier, str(ctx.body.client_id, 40), ctx.body.redirect_uri ? str(ctx.body.redirect_uri, 500) : undefined);
  };

  route("POST", "/api/id/token", (ctx) => token(ctx, false), false, { csrf: false });
  if (signer) route("POST", "/realms/cumulus/protocol/openid-connect/token", (ctx) => token(ctx, true), false, { csrf: false });

  const backTo = (q: URLSearchParams) => {
    const clientId = str(q.get("client_id"), 40);
    const redirectUri = str(q.get("redirect_uri"), 500);
    if (!idClientFor(clientId, redirectUri)) throw new HttpError(400, "This sign-in request didn't come from an Infinitum product.");
    return { clientId, url: new URL(redirectUri) };
  };
  const withFragment = (url: URL, params: Record<string, string>) => {
    url.hash = new URLSearchParams(params).toString();
    return new Redirect(url.toString());
  };

  route("GET", "/api/id/redeem", async (ctx) => {
    const q = ctx.query as URLSearchParams;
    const { clientId, url } = backTo(q);
    const state = str(q.get("state"), 200);
    try {
      const out = await redeem(ctx, str(q.get("code"), 64), str(q.get("code_verifier"), 128), clientId);
      const profile = Buffer.from(JSON.stringify(out.profile)).toString("base64url");
      return withFragment(url, { cid_token: out.access_token, expires_in: String(out.expires_in), state, profile });
    } catch (e) {
      return withFragment(url, { cid_error: (e as Error).message || "Sign-in failed. Please try again.", state });
    }
  }, false);

  route("GET", "/api/id/end", async (ctx) => {
    const q = ctx.query as URLSearchParams;
    const { url } = backTo(q);
    const tokenValue = str(q.get("token"), 8000);
    try {
      if (OPAQUE.test(tokenValue) || JWT.test(tokenValue)) {
        const hit = await accountFromToken(tokenValue);
        await cid.revokeSession(hit.account.cid, hit.sessionId);
      }
    } catch {
      // An unknown token still returns the person to the product. Nothing was signed in.
    }
    return new Redirect(url.toString());
  }, false);

  const userinfo = async (ctx: any) => {
    cors(ctx);
    return profileOf((await accountFromToken(presented(ctx))).account);
  };
  route("GET", "/api/id/userinfo", userinfo, false);
  if (signer) route("GET", "/realms/cumulus/protocol/openid-connect/userinfo", userinfo, false);

  route("POST", "/api/id/signout", async (ctx) => {
    cors(ctx);
    const hit = await accountFromToken(presented(ctx));
    await cid.revokeSession(hit.account.cid, hit.sessionId);
    return { ok: true };
  }, false, { csrf: false });

  route("GET", "/api/id/me", (ctx) => (ctx.user ? profileOf(ctx.user.account) : { signedIn: false }), false, { optionalAuth: true });

  // Server-to-server only, for the move to InfinitumCorp/cumulus-id: every account with its passkeys,
  // linked identities, confirmed authenticator app and grants. Never sessions, token hashes,
  // challenges or OAuth state. Off unless CID_EXPORT_KEY_SHA256 is set; no CORS headers at all.
  const exportKey = h.exportKeySha256;
  if (exportKey) {
    route("POST", "/api/id/export", (ctx) => {
      for (const name of ["Access-Control-Allow-Origin", "Access-Control-Allow-Credentials", "Access-Control-Allow-Methods", "Access-Control-Allow-Headers", "Access-Control-Max-Age"]) {
        ctx.res.removeHeader(name);
      }
      if (!labyrinthDirectoryKeyMatches(ctx.req.headers["x-cid-export-key"], exportKey)) throw new HttpError(401, "Unknown export client");
      return exportCidAccounts(cid);
    }, false, { csrf: false });
  }

  // Server-to-server only: the hosted Labyrinth asks who a presented token belongs to.
  // No CORS headers are set, so a browser page can never read an answer.
  const directoryKey = h.labyrinthDirectoryKeySha256;
  if (directoryKey) {
    route("POST", "/api/id/labyrinth-directory", async (ctx) => {
      if (!labyrinthDirectoryKeyMatches(ctx.req.headers["x-cid-directory-key"], directoryKey)) throw new HttpError(401, "Unknown directory client");
      const resolve = async (token: string) => {
        if (!(OPAQUE.test(token) || JWT.test(token))) return null;
        try {
          const hit = await accountFromToken(token);
          return { cid: hit.account.cid, sessionId: hit.sessionId };
        } catch {
          return null;
        }
      };
      try {
        return await answerLabyrinthDirectory(cid, resolve, ctx.body);
      } catch (err) {
        if (err instanceof LabyrinthDirectoryError) throw new HttpError(err.status, err.message);
        throw err;
      }
    }, false, { csrf: false });
  }
}
