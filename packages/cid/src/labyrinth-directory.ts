import { createHash, timingSafeEqual } from "node:crypto";
import type { CidService } from "./service.ts";

/**
 * The narrow Cumulus://ID directory a separately hosted Labyrinth service needs.
 *
 * Labyrinth repositories can live on another host (Google Cloud Run) while Cumulus://ID stays
 * authoritative for sign-in. That host calls POST /api/id/labyrinth-directory with a service
 * key. Every answer is computed live from the CID store, inside the CID host's transaction:
 *
 *   resolve       { token }            the presenting person's CID, session, org and LBRNTH scopes
 *   session       { cid, sessionId }   is that session still active, plus org and LBRNTH scopes
 *   membership    { cid }              a CID's current directory organization (null when none)
 *   organization  { token, name }      create the first organization for a directly signed-in CID
 *   consent       { token, scopes }    record explicit LBRNTH scope consent for that CID
 *
 * Only the LBRNTH app's grants are visible or writable here. Writes need the person's own CID
 * token, never just the service key. Consent never buys a plan or grants an org role.
 */

export const LABYRINTH_SCOPES = ["repo:read", "repo:write", "repo:admin"] as const;
export type LabyrinthDirectoryScope = (typeof LABYRINTH_SCOPES)[number];

export interface LabyrinthDirectoryOrg { id: string; name: string; admin: boolean }
export interface LabyrinthDirectoryIdentity { cid: string; sessionId: string; organization: LabyrinthDirectoryOrg | null; scopes: LabyrinthDirectoryScope[] }

/** Resolves a presented CID token (opaque session token or signed access token). */
export type CidTokenResolver = (token: string) => { cid: string; sessionId: string } | null | Promise<{ cid: string; sessionId: string } | null>;

export class LabyrinthDirectoryError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const TOKEN = /^[A-Za-z0-9_.-]{20,8000}$/;
const SHORT = /^[A-Za-z0-9_:.-]{1,200}$/;

/** True when `presented` hashes to `expectedSha256Hex`. Constant time; an unset hash never matches. */
export function labyrinthDirectoryKeyMatches(presented: unknown, expectedSha256Hex: string | undefined): boolean {
  if (typeof presented !== "string" || presented.length < 32 || presented.length > 512) return false;
  // One hash, or several separated by commas (one per hosted Labyrinth: Russia, US). Any malformed entry disables the check.
  const expected = (expectedSha256Hex ?? "").split(",").map(h => h.trim()).filter(Boolean);
  if (!expected.length || expected.length > 8 || !expected.every(h => /^[0-9a-f]{64}$/.test(h))) return false;
  const got = createHash("sha256").update(presented).digest();
  let match = false;
  for (const h of expected) match = timingSafeEqual(got, Buffer.from(h, "hex")) || match; // compare all, no early exit
  return match;
}

async function membership(cid: CidService, who: string): Promise<LabyrinthDirectoryOrg | null> {
  if (!(await cid.findAccount(who))) return null;
  return await cid.organizationMembership(who);
}

async function scopes(cid: CidService, who: string): Promise<LabyrinthDirectoryScope[]> {
  const out: LabyrinthDirectoryScope[] = [];
  for (const scope of LABYRINTH_SCOPES) if (await cid.can(who, "LBRNTH", scope)) out.push(scope);
  return out;
}

/** Answer one directory call. Throws LabyrinthDirectoryError for a refused or malformed call. */
export async function answerLabyrinthDirectory(cid: CidService, resolveToken: CidTokenResolver, body: unknown): Promise<unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new LabyrinthDirectoryError(400, "Invalid directory call");
  const b = body as Record<string, unknown>;
  const token = async (): Promise<{ cid: string; sessionId: string }> => {
    if (typeof b.token !== "string" || !TOKEN.test(b.token)) throw new LabyrinthDirectoryError(401, "Cumulus ID sign-in required");
    const hit = await resolveToken(b.token);
    if (!hit) throw new LabyrinthDirectoryError(401, "Cumulus ID session expired or revoked");
    return hit;
  };
  const short = (v: unknown): string => {
    if (typeof v !== "string" || !SHORT.test(v)) throw new LabyrinthDirectoryError(400, "Invalid directory call");
    return v;
  };
  switch (b.op) {
    case "resolve": {
      const hit = await token();
      return { cid: hit.cid, sessionId: hit.sessionId, organization: await membership(cid, hit.cid), scopes: await scopes(cid, hit.cid) } satisfies LabyrinthDirectoryIdentity;
    }
    case "session": {
      const who = short(b.cid);
      const sessionId = short(b.sessionId);
      const active = !!(await cid.findAccount(who)) && (await cid.isSessionActive(who, sessionId));
      return { active, organization: active ? await membership(cid, who) : null, scopes: active ? await scopes(cid, who) : [] };
    }
    case "membership":
      return { organization: await membership(cid, short(b.cid)) };
    case "organization": {
      const hit = await token();
      const name = typeof b.name === "string" ? b.name.trim() : "";
      if (!name || name.length > 120 || /[\x00-\x1f\x7f]/.test(name)) throw new LabyrinthDirectoryError(400, "Organization name required");
      if (await membership(cid, hit.cid)) throw new LabyrinthDirectoryError(409, "Account already belongs to an organization");
      const org = await cid.createOrganization(name, hit.cid);
      return { id: org.id, name: org.name };
    }
    case "consent": {
      const hit = await token();
      const wanted = b.scopes;
      if (!Array.isArray(wanted) || wanted.length === 0 || wanted.length > 3 || wanted.some((s) => !(LABYRINTH_SCOPES as readonly unknown[]).includes(s))) {
        throw new LabyrinthDirectoryError(400, "Invalid Labyrinth consent scopes");
      }
      const list = [...new Set(wanted as LabyrinthDirectoryScope[])];
      // Idempotent: a repeat consent must not append to the ledger again.
      const held = await scopes(cid, hit.cid);
      if (!list.every((scope) => held.includes(scope))) await cid.grant(hit.cid, "LBRNTH", list);
      return { app: "LBRNTH", scopes: await scopes(cid, hit.cid) };
    }
    default:
      throw new LabyrinthDirectoryError(400, "Invalid directory call");
  }
}
