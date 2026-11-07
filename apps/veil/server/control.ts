import type { CidService } from "@infinitum/cid";
import { parseBridges, veilFail } from "./model.ts";

export interface VeilIdentity {
  cid: string;
  username: string;
  sessionId: string;
}

export interface VeilControlOptions {
  cid: CidService;
  /** Explicit VEIL plan. Anything other than `true` is a denial, including throws. */
  entitled?: (cid: string) => boolean;
  /** Optional bridge lines. Not consulted while routing browser traffic. */
  bridges?: readonly unknown[];
}

/**
 * Premium bridge list only. A Cumulus ID session does not turn Tor on,
 * and this service never returns a proxy password or an exit address to route through.
 */
export function createVeilControl(options: VeilControlOptions) {
  const cid = options.cid;
  const entitled = options.entitled ?? (() => false);
  const bridges = parseBridges([...(options.bridges ?? [])]);

  const hasPlan = (accountId: string): boolean => {
    try {
      return entitled(accountId) === true;
    } catch {
      return false;
    }
  };

  const identify = (token: string): VeilIdentity => {
    if (typeof token !== "string" || !token || token.length > 512) {
      veilFail("sign_in_required", "Cumulus ID sign-in required", 401);
    }
    const auth = cid.authenticate(token);
    if (!auth || !cid.isSessionActive(auth.account.cid, auth.session.id)) {
      veilFail("sign_in_required", "Cumulus ID session expired or revoked", 401);
    }
    return { cid: auth.account.cid, username: auth.account.username, sessionId: auth.session.id };
  };

  return {
    session(token: string) {
      const identity = identify(token);
      return {
        cid: identity.cid,
        username: identity.username,
        entitled: hasPlan(identity.cid),
        browserOnly: true as const,
        deviceWide: false as const,
        routing: "local-tor" as const,
      };
    },
    bridges(token: string) {
      const identity = identify(token);
      if (!hasPlan(identity.cid)) veilFail("veil_plan_required", "This Cumulus ID has no VEIL entitlement", 403);
      return {
        bridges: [...bridges],
        optional: true as const,
        routing: "local-tor" as const,
        deviceWide: false as const,
      };
    },
  };
}

export type VeilControl = ReturnType<typeof createVeilControl>;
