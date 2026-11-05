/**
 * Who is calling. In production this is a Cumulus://ID session: the same bearer token every
 * Infinitum product accepts, plus the person's METATRON grants in their CID permissions.
 */
import type { CidService } from "@infinitum/cid";

export interface Principal {
  cid: string;
  /** When the session was created; approvals require a recent sign-in. */
  sessionStartedAt: string;
  canRead: boolean;
  canTrade: boolean;
}

export type Authenticate = (token: string) => Promise<Principal | null> | Principal | null;

/** METATRON scopes a person grants in Cumulus://ID. */
export const SCOPES = { read: "money:read", trade: "money:trade" } as const;

export function cidAuth(cid: CidService): Authenticate {
  return (token) => {
    const s = cid.authenticate(token);
    if (!s) return null;
    return {
      cid: s.account.cid,
      sessionStartedAt: s.session.createdAt,
      canRead: cid.can(s.account.cid, "metatron", SCOPES.read),
      canTrade: cid.can(s.account.cid, "metatron", SCOPES.trade),
    };
  };
}

/**
 * Local development only: METATRON_DEV_TOKENS="token1:cid1,token2:cid2". Refused when
 * NODE_ENV=production so it can't be left on by accident.
 */
export function devAuth(spec: string | undefined, env = process.env.NODE_ENV): Authenticate | null {
  if (!spec) return null;
  if (env === "production") throw new Error("METATRON_DEV_TOKENS must not be set in production");
  const map = new Map(spec.split(",").map((p) => p.trim().split(":") as [string, string]).filter(([t, c]) => t && c && t.length >= 16));
  if (!map.size) throw new Error("METATRON_DEV_TOKENS needs token:cid pairs with tokens of at least 16 characters");
  return (token) => {
    const cid = map.get(token);
    return cid ? { cid, sessionStartedAt: new Date().toISOString(), canRead: true, canTrade: true } : null;
  };
}
