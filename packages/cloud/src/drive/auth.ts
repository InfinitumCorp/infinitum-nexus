import { CidService } from "@infinitum/cid";

/** Cumulus://Cloud is its own CID app so Drive access can be revoked without touching Mail. */
export const DRIVE_APP = "cumulus-cloud";

export interface DrivePrincipal {
  cid: string;
  sessionId: string;
}

export interface DriveAuth {
  authenticate(token: string): DrivePrincipal | null;
  can(cid: string, scope: "drive:read" | "drive:write"): boolean;
  grantDrive(cid: string): Promise<void>;
}

/** Adapts a real Cumulus://ID service. The caller never supplies the CID in the body. */
export function cidAuth(cid: CidService): DriveAuth {
  return {
    authenticate(token: string): DrivePrincipal | null {
      const hit = cid.authenticate(token);
      if (!hit) return null;
      return { cid: hit.account.cid, sessionId: hit.session.id };
    },
    can(id: string, scope: "drive:read" | "drive:write"): boolean {
      return cid.can(id, DRIVE_APP, scope);
    },
    async grantDrive(id: string): Promise<void> {
      await cid.grant(id, DRIVE_APP, ["drive:read", "drive:write"]);
    },
  };
}
