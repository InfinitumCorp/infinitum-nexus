import { answerLabyrinthDirectory } from "@infinitum/cid";
import type { CidService, CidTokenResolver } from "@infinitum/cid";
import type { Scope } from "./model.ts";

export interface DirectoryOrg { id: string; name: string; admin: boolean }
export interface DirectoryIdentity { cid: string; sessionId: string; organization: DirectoryOrg | null; scopes: Scope[] }
export interface DirectorySession { active: boolean; organization: DirectoryOrg | null; scopes: Scope[] }

/** Authoritative, live Cumulus://ID answers for a Labyrinth host that does not hold the CID store. */
export interface CidDirectory {
  /** null when the token is unknown, expired or revoked. */
  resolve(token: string): Promise<DirectoryIdentity | null>;
  session(cid: string, sessionId: string): Promise<DirectorySession>;
  membership(cid: string): Promise<DirectoryOrg | null>;
  createOrganization(token: string, name: string): Promise<{ id: string; name: string }>;
  consent(token: string, scopes: Scope[]): Promise<{ app: string; scopes: Scope[] }>;
}

export class CidDirectoryError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const SCOPES: readonly string[] = ["repo:read", "repo:write", "repo:admin"];
const bad = (): never => { throw new CidDirectoryError(502, "Malformed Cumulus ID directory answer"); };
const str = (v: unknown, max = 200): string => typeof v === "string" && v.length > 0 && v.length <= max ? v : bad();
const org = (v: unknown): DirectoryOrg | null => {
  if (v === null) return null;
  if (!v || typeof v !== "object") return bad();
  const o = v as Record<string, unknown>;
  return { id: str(o.id, 120), name: str(o.name, 120), admin: typeof o.admin === "boolean" ? o.admin : bad() };
};
const scopes = (v: unknown): Scope[] => Array.isArray(v) && v.every(s => SCOPES.includes(s as string)) ? [...v] as Scope[] : bad();

/**
 * Calls POST https://id.cumuluscloud.app/api/id/labyrinth-directory with the service key.
 * HTTPS only (loopback HTTP for development), no redirects, 10-second timeout.
 */
export class RemoteCidDirectory implements CidDirectory {
  readonly #url: string;
  readonly #key: string;
  readonly #fetch: typeof fetch;
  constructor(url: string, key: string, fetchImpl: typeof fetch = (input, init) => fetch(input, init)) {
    const u = new URL(url);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    if (u.username || u.password || u.search || u.hash || !(u.protocol === "https:" || (u.protocol === "http:" && loopback))) throw new Error("CID directory URL must be HTTPS");
    if (typeof key !== "string" || key.length < 32 || key.length > 512) throw new Error("CID directory key must be 32-512 characters");
    this.#url = u.toString();
    this.#key = key;
    this.#fetch = fetchImpl;
  }
  async #call(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.#fetch(this.#url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000), headers: { "content-type": "application/json", "x-cid-directory-key": this.#key }, body: JSON.stringify(body) });
    } catch {
      throw new CidDirectoryError(502, "Cumulus ID directory unreachable");
    }
    const text = await res.text();
    if (!res.ok) {
      let message = "Cumulus ID directory refused the call";
      try { const e = JSON.parse(text) as { error?: unknown }; if (typeof e.error === "string") message = e.error.slice(0, 200); } catch { /* keep the generic message */ }
      throw new CidDirectoryError([400, 401, 403, 404, 409].includes(res.status) ? res.status : 502, message);
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : bad();
    } catch {
      return bad();
    }
  }
  async resolve(token: string): Promise<DirectoryIdentity | null> {
    try {
      const r = await this.#call({ op: "resolve", token });
      return { cid: str(r.cid), sessionId: str(r.sessionId), organization: org(r.organization), scopes: scopes(r.scopes) };
    } catch (err) {
      if (err instanceof CidDirectoryError && err.status === 401) return null;
      throw err;
    }
  }
  async session(cid: string, sessionId: string): Promise<DirectorySession> {
    const r = await this.#call({ op: "session", cid, sessionId });
    return { active: r.active === true, organization: org(r.organization), scopes: scopes(r.scopes) };
  }
  async membership(cid: string): Promise<DirectoryOrg | null> {
    return org((await this.#call({ op: "membership", cid })).organization);
  }
  async createOrganization(token: string, name: string) {
    const r = await this.#call({ op: "organization", token, name });
    return { id: str(r.id, 120), name: str(r.name, 120) };
  }
  async consent(token: string, wanted: Scope[]) {
    const r = await this.#call({ op: "consent", token, scopes: wanted });
    return { app: str(r.app), scopes: scopes(r.scopes) };
  }
}

/** The same directory answered in-process from a CidService (tests and single-process hosts). */
export class LocalCidDirectory implements CidDirectory {
  readonly #cid: CidService;
  readonly #resolve: CidTokenResolver;
  constructor(cid: CidService, resolve?: CidTokenResolver) {
    this.#cid = cid;
    this.#resolve = resolve ?? (async token => { const hit = await cid.authenticate(token); return hit ? { cid: hit.account.cid, sessionId: hit.session.id } : null; });
  }
  async #call(body: Record<string, unknown>) {
    try {
      return await answerLabyrinthDirectory(this.#cid, this.#resolve, body) as Record<string, unknown>;
    } catch (err) {
      const status = (err as { status?: number }).status;
      throw new CidDirectoryError(typeof status === "number" ? status : 502, (err as Error).message);
    }
  }
  async resolve(token: string) {
    try { return await this.#call({ op: "resolve", token }) as unknown as DirectoryIdentity; }
    catch (err) { if (err instanceof CidDirectoryError && err.status === 401) return null; throw err; }
  }
  async session(cid: string, sessionId: string) { return await this.#call({ op: "session", cid, sessionId }) as unknown as DirectorySession; }
  async membership(cid: string) { return (await this.#call({ op: "membership", cid })).organization as DirectoryOrg | null; }
  async createOrganization(token: string, name: string) { return await this.#call({ op: "organization", token, name }) as { id: string; name: string }; }
  async consent(token: string, wanted: Scope[]) { return await this.#call({ op: "consent", token, scopes: wanted }) as { app: string; scopes: Scope[] }; }
}
