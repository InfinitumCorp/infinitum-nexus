import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/**
 * Labyrinth sessions for the standalone Cumulus://ID issuer's access tokens (client mode, SPECTRE_AUTH=oidc).
 *
 * The directory's `resolve` answers such a token with the session id
 *
 *   issuer.<exp>.<sid tag>.<mac>
 *
 * and its `session` op (repository bearers check their parent session with it) accepts only ids this +SPCTR made:
 * the MAC binds the cid, the issuer session and the expiry under a key derived from +SPCTR's own secret, so neither
 * the directory key nor a row written to Labyrinth's database can mint one for another account. An id is live
 * until the access token's expiry, and never more than an access token's lifetime ahead.
 *
 * Known limit: the session op can't ask the issuer whether that session was signed out (it has no token then), so a
 * repository bearer minted from such a token (15 minutes) outlives a sign-out at the issuer by at most its own
 * lifetime. A token presented directly is checked with the issuer every time (accessToken()'s 30-second cache aside).
 */

const ID = /^issuer\.(\d{10})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})$/;
/** The issuer's access-token lifetime (cumulus-id TTL.access, 1 hour) plus clock skew. */
const MAX_AHEAD_MS = 65 * 60 * 1000;

export interface IssuerSessions {
  id(cid: string, sid: string, exp: number): string;
  active(cid: string, sessionId: string): boolean;
}

export function issuerSessions(secret: Buffer, now: () => number = Date.now): IssuerSessions {
  const key = Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), "spectre labyrinth issuer session v1", 32));
  const mac = (cid: string, tag: string, exp: string) => createHmac("sha256", key).update(`${cid}|${tag}|${exp}`).digest("base64url");
  return {
    id(cid, sid, exp) {
      const e = String(Math.floor(exp));
      const tag = createHash("sha256").update(`cid-issuer-session:${sid}`).digest("base64url").slice(0, 16);
      return `issuer.${e}.${tag}.${mac(cid, tag, e)}`;
    },
    active(cid, sessionId) {
      const m = ID.exec(sessionId);
      if (!m) return false;
      const [, exp, tag, given] = m as unknown as [string, string, string, string];
      const t = now();
      const at = Number(exp) * 1000;
      if (at <= t || at > t + MAX_AHEAD_MS) return false;
      const want = Buffer.from(mac(cid, tag, exp));
      const got = Buffer.from(given);
      return want.length === got.length && timingSafeEqual(want, got);
    },
  };
}
