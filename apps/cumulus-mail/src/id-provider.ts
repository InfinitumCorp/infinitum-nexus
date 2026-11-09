/**
 * "Sign in with Cumulus://ID" for every Infinitum product (OAuth 2.0 authorization code + PKCE,
 * RFC 7636). mail.cumuluscloud.app holds the Cumulus://ID session, so a product site sends people
 * here and gets them back already signed in:
 *
 *   1. The product opens  GET /api/id/authorize?client_id=scalvs&redirect_uri=https://scalvs.app/...
 *                              &code_challenge=<S256>&code_challenge_method=S256&state=<random>
 *      Not signed in here yet: the sign-in page opens first, then the request continues.
 *   2. We redirect to redirect_uri?code=<one-time code>&state=<state>.
 *   3. The product calls POST /api/id/token { code, code_verifier, client_id } and receives
 *      { access_token, profile }. Codes last 2 minutes and work once.
 *   4. GET /api/id/userinfo with "Authorization: Bearer <access_token>" returns the profile again.
 *      POST /api/id/signout with the same header ends that session.
 *
 * Only the product origins listed in ID_CLIENTS may receive codes. Each sign-in records a
 * "profile:read" grant for that product, so it shows (and can be revoked) in CID permissions.
 * public/id/button.js is a drop-in button that does all of this for a static site.
 */
import type { CidService, Account } from "@infinitum/cid";

export interface IdClient {
  name: string;
  /** CID app id the grant is recorded under. */
  app: string;
  origins: string[];
}

export const ID_CLIENTS: Record<string, IdClient> = {
  infinitum: { name: "Infinitum Corporation", app: "cumulus", origins: ["https://infinitumcorporation.ai", "https://www.infinitumcorporation.ai", "https://downloads.infinitumcorporation.ai"] },
  "cumulus-cloud": { name: "Cumulus://Cloud", app: "cumulus", origins: ["https://cumuluscloud.app", "https://www.cumuluscloud.app", "https://mail.cumuluscloud.app", "https://ru.mail.cumuluscloud.app"] },
  scalvs: { name: "SCALVS.ai", app: "scalvs", origins: ["https://scalvs.app", "https://www.scalvs.app"] },
  metatron: { name: "METATRON¹⁰⁰", app: "metatron", origins: ["https://mttrn.app", "https://www.mttrn.app"] },
  architect: { name: ":\\ARCHITECT\\", app: "architect", origins: ["https://rchtch.app", "https://www.rchtch.app"] },
  veil: { name: "VEIL</>", app: "veil", origins: ["https://infinitumveil.app", "https://www.infinitumveil.app"] },
  "veil-vpn": { name: "VEIL</> VPN", app: "veil", origins: ["https://infinitumveilvpn.app", "https://www.infinitumveilvpn.app"] },
  fabric: { name: "FabriC++", app: "fabric", origins: ["https://infinitumfabric.app", "https://www.infinitumfabric.app"] },
  "firm-wallet": { name: "$FIRM Wallet", app: "firm-wallet", origins: ["https://firmwallet.app", "https://www.firmwallet.app"] },
  firmament: { name: "$Firmament Network", app: "firmament", origins: ["https://firmnetwork.app", "https://www.firmnetwork.app"] },
  spectre: { name: "+SPCTR", app: "spectre", origins: ["https://spectre.infinitumcorporation.ai"] },
  defense: { name: "Infinitum Defense", app: "cumulus", origins: ["https://infinitumdefense.com", "https://www.infinitumdefense.com"] },
};

/** The client a redirect may go to, or null when it isn't one of ours. */
export function idClientFor(clientId: string, redirectUri: string): IdClient | null {
  const client = Object.prototype.hasOwnProperty.call(ID_CLIENTS, clientId) ? ID_CLIENTS[clientId]! : null;
  if (!client) return null;
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return null;
  }
  if (url.username || url.password || url.hash) return null;
  return client.origins.includes(url.origin) ? client : null;
}

/** Every origin that may call the token endpoints from a browser. */
const ALL_ORIGINS = new Set(Object.values(ID_CLIENTS).flatMap((c) => c.origins));

export const profileOf = (a: Account) => ({ cid: a.cid, username: a.username, email: a.mailAddress, name: a.username });

interface Helpers {
  route: (method: string, path: string, handler: (ctx: any) => unknown, auth?: boolean, opts?: { csrf?: boolean; optionalAuth?: boolean }) => void;
  cid: CidService;
  origin: string;
  sessionCookie: (token: string, maxAge?: number) => string;
  device: (ctx: any) => string;
  need: (ctx: any, ...fields: string[]) => void;
  str: (v: unknown, max?: number) => string;
  Redirect: new (location: string) => unknown;
  HttpError: new (status: number, message: string) => Error;
}

export function registerIdProvider(h: Helpers) {
  const { route, cid, str, Redirect, HttpError } = h;
  const cors = (ctx: any) => {
    const o = ctx.req.headers.origin;
    if (typeof o === "string" && ALL_ORIGINS.has(o)) {
      ctx.res.setHeader("Access-Control-Allow-Origin", o);
      ctx.res.setHeader("Vary", "Origin");
    }
  };
  const bearer = (ctx: any) => {
    // Header for servers; a text/plain body field for browsers, so no CORS preflight is needed.
    const m = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/.exec(String(ctx.req.headers.authorization ?? ""));
    const fromBody = typeof ctx.body?.access_token === "string" && /^[A-Za-z0-9_-]{20,200}$/.test(ctx.body.access_token) ? ctx.body.access_token : null;
    const token = m ? m[1]! : fromBody;
    const hit = token ? cid.authenticate(token) : null;
    if (!hit) throw new HttpError(401, "Not signed in");
    return hit;
  };

  route("GET", "/api/id/authorize", async (ctx: any) => {
    const q = ctx.query as URLSearchParams;
    const clientId = str(q.get("client_id"), 40);
    const redirectUri = str(q.get("redirect_uri"), 500);
    const challenge = str(q.get("code_challenge"), 64);
    const state = str(q.get("state"), 200);
    const client = idClientFor(clientId, redirectUri);
    if (!client) throw new HttpError(400, "This sign-in request didn't come from an Infinitum product.");
    if ((q.get("code_challenge_method") ?? "S256") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
      throw new HttpError(400, "This sign-in request is missing its security check. Start again from the product.");
    }
    if (!ctx.user) {
      // Sign in here first, then come straight back to this request.
      const back = `/api/id/authorize?${q.toString()}`;
      return new Redirect(`/?next=${encodeURIComponent(back)}&for=${encodeURIComponent(client.name)}`);
    }
    const account = ctx.user.account as Account;
    if (!cid.can(account.cid, client.app, "profile:read")) await cid.grant(account.cid, client.app, ["profile:read"]);
    const { code } = await cid.grantDeviceHandoff(account.cid, challenge, clientId);
    const to = new URL(redirectUri);
    to.searchParams.set("code", code);
    if (state) to.searchParams.set("state", state);
    return new Redirect(to.toString());
  }, false, { optionalAuth: true });

  // Called from product pages with a simple (no-preflight) request: text/plain JSON body.
  route("POST", "/api/id/token", async (ctx: any) => {
    cors(ctx);
    h.need(ctx, "code", "code_verifier", "client_id");
    const { token, session, app } = await cid.redeemDeviceHandoff(str(ctx.body.code, 64), str(ctx.body.code_verifier, 128), h.device(ctx));
    if (app !== str(ctx.body.client_id, 40)) {
      await cid.revokeSession(session.cid, session.id);
      throw new HttpError(400, "That sign-in code belongs to another product.");
    }
    const expiresIn = Math.max(0, Math.floor((new Date(session.expiresAt).getTime() - Date.now()) / 1000));
    return { access_token: token, token_type: "Bearer", expires_in: expiresIn, profile: profileOf(cid.getAccount(session.cid)) };
  }, false, { csrf: false });

  route("GET", "/api/id/userinfo", (ctx: any) => {
    cors(ctx);
    return profileOf(bearer(ctx).account);
  }, false);

  route("POST", "/api/id/signout", async (ctx: any) => {
    cors(ctx);
    const hit = bearer(ctx);
    await cid.revokeSession(hit.account.cid, hit.session.id);
    return { ok: true };
  }, false, { csrf: false });

  /** Who is signed in here, for the account menu on this origin's own pages (Drive, Dox, ...). */
  route("GET", "/api/id/me", (ctx: any) => (ctx.user ? profileOf(ctx.user.account) : { signedIn: false }), false, { optionalAuth: true });
}
