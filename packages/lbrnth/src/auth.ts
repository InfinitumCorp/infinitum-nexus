import { createHash, randomBytes } from "node:crypto";
import { Labyrinth } from "./service.ts";
import { LabyrinthError } from "./model.ts";
import type { CommitInput, LabyrinthOptions, Role, Scope, LabyrinthStorage } from "./model.ts";
import { labyrinthProduct } from "@infinitum/lbrnth-client";

export interface CidLabyrinthOptions extends Pick<LabyrinthOptions, "entitled" | "clock" | "limits"> {
  /** Explicit storage is mandatory; MemoryStorage must be deliberately selected for tests. */
  storage: LabyrinthStorage;
  /**
   * A Labyrinth the host already built over `storage` (LabyrinthHost shares one across
   * requests). Its can/canProvision callbacks must consult the same CID authority.
   */
  labyrinth?: Labyrinth;
  /** Where repository-only bearer grants live. Defaults to process memory. */
  delegations?: DelegationStore;
}

/**
 * The Cumulus://ID operations Labyrinth relies on. CidService satisfies it directly;
 * LabyrinthHost supplies a per-request view of a remote, authoritative CID directory.
 */
export interface CidAuthority {
  authenticate(token: string): { account: { cid: string }; session: { id: string } } | null;
  isSessionActive(cid: string, sessionId: string): boolean;
  organizationMembership(cid: string): { id: string; name: string; admin: boolean } | null;
  can(cid: string, app: string, scope: string): boolean;
  permissions(cid: string): { app: string; scopes: string[] }[];
  createOrganization(name: string, adminCid: string): Promise<{ id: string; name: string }>;
  grant(cid: string, app: string, scopes: string[]): Promise<unknown>;
}

/** A repository-only bearer grant. Only the SHA-256 of the bearer is ever a key. */
export interface DelegationGrant { cid: string; orgId: string; parentSession: string; expires: number }
export interface DelegationStore {
  get(tokenHash: string): DelegationGrant | undefined;
  set(tokenHash: string, grant: DelegationGrant): void;
  delete(tokenHash: string): void;
  entries(): Iterable<[string, DelegationGrant]>;
  readonly size: number;
}

/** Cumulus://ID is the authority: raw CID/org strings are never credentials. */
export class CidLabyrinth {
  readonly #cid: CidAuthority;
  readonly #lab: Labyrinth;
  readonly #clock: () => Date;
  readonly #grants: DelegationStore;
  #tokenHash(token: string) { return createHash("sha256").update(token).digest("hex"); }
  constructor(cid: CidAuthority, options: CidLabyrinthOptions) {
    if (!options.storage) throw new LabyrinthError("invalid", "Explicit Labyrinth storage is required");
    this.#cid = cid;
    this.#clock = options.clock ?? (() => new Date());
    this.#grants = options.delegations ?? new Map();
    this.#lab = options.labyrinth ?? new Labyrinth({ ...options, can: cid.can.bind(cid), canProvision: (actor, orgId) => {
      const membership = cid.organizationMembership(actor);
      return membership?.id === orgId && membership.admin;
    } });
  }
  #identity(token: string) {
    if (typeof token !== "string" || !token || token.length > 512) throw new LabyrinthError("forbidden", "Cumulus ID sign-in required");
    const auth = this.#cid.authenticate(token);
    const delegated = token.startsWith("lbrnth_") ? this.#grants.get(this.#tokenHash(token)) : undefined;
    const validDelegation = delegated && delegated.expires > this.#clock().getTime() && this.#cid.isSessionActive(delegated.cid, delegated.parentSession);
    const actor = auth?.account.cid ?? (validDelegation ? delegated.cid : undefined);
    if (!actor) throw new LabyrinthError("forbidden", "Cumulus ID session expired or revoked");
    const org = this.#cid.organizationMembership(actor);
    if (!org || (delegated && org.id !== delegated.orgId)) throw new LabyrinthError("forbidden", "Client organization membership required");
    return { cid: actor, org, parentSession: auth?.session.id ?? delegated!.parentSession, delegated: !auth };
  }
  session(token: string) {
    const direct = this.#cid.authenticate(token);
    const identity = direct ? { cid: direct.account.cid, org: this.#cid.organizationMembership(direct.account.cid), delegated: false } : this.#identity(token);
    return { cid: identity.cid, organization: identity.org ? { id: identity.org.id, name: identity.org.name, admin: identity.org.admin } : null, delegated: identity.delegated,
      scopes: (["repo:read", "repo:write", "repo:admin"] as Scope[]).filter(scope => this.#cid.can(identity.cid, "LBRNTH", scope)) };
  }
  async createOrganization(token: string, name: string) {
    const direct = this.#cid.authenticate(token);
    if (!direct) throw new LabyrinthError("forbidden", "Direct Cumulus ID sign-in required");
    if (this.#cid.organizationMembership(direct.account.cid)) throw new LabyrinthError("conflict", "Account already belongs to an organization");
    if (typeof name !== "string" || !name.trim() || name.length > 120 || /[\x00-\x1f\x7f]/.test(name)) throw new LabyrinthError("invalid", "Organization name required");
    const org = await this.#cid.createOrganization(name.trim(), direct.account.cid);
    return { id: org.id, name: org.name };
  }
  /** Exchange an authenticated browser CID cookie for a short-lived, repository-only bearer.
   * This credential is NOT a CID login token and cannot authenticate to other CID products. */
  issueToken(token: string): { token: string; expiresAt: string } {
    const identity = this.#identity(token);
    if (identity.delegated) throw new LabyrinthError("forbidden", "A direct Cumulus ID session is required to issue credentials");
    this.#lab.recordCredentialIssue(identity.cid, identity.org.id); // live plan, membership, read consent, no credential bytes in audit
    const now = this.#clock().getTime();
    for (const [hash, grant] of [...this.#grants.entries()]) if (grant.expires <= now || !this.#cid.isSessionActive(grant.cid, grant.parentSession)) this.#grants.delete(hash);
    if (this.#grants.size >= 1000 || [...this.#grants.entries()].filter(([, g]) => g.parentSession === identity.parentSession).length >= 8) throw new LabyrinthError("capacity", "Repository credential capacity exceeded");
    const bearer = `lbrnth_${randomBytes(32).toString("base64url")}`;
    const expires = now + 15 * 60000;
    this.#grants.set(this.#tokenHash(bearer), { cid: identity.cid, orgId: identity.org.id, parentSession: identity.parentSession, expires });
    return { token: bearer, expiresAt: new Date(expires).toISOString() };
  }
  /** Explicit user consent, recorded by CID/Firmament; never grants a paid plan or a team role. */
  async consent(token: string, scopes: Scope[]) {
    const identity = this.#identity(token);
    if (identity.delegated) throw new LabyrinthError("forbidden", "Direct Cumulus ID sign-in required for consent");
    if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > 3 || scopes.some(scope => !["repo:read", "repo:write", "repo:admin"].includes(scope))) throw new LabyrinthError("invalid", "Invalid Labyrinth consent scopes");
    // Idempotent repeat consent must not become an unbounded ledger-append endpoint.
    if (scopes.every(scope => this.#cid.can(identity.cid, "LBRNTH", scope))) return this.#cid.permissions(identity.cid).find(grant => grant.app === "LBRNTH")!;
    return this.#cid.grant(identity.cid, "LBRNTH", scopes);
  }
  provision(token: string) {
    const { cid, org } = this.#identity(token);
    return this.#lab.createOrganization(cid, org.id, org.name);
  }
  /** Retained handles reauthenticate on EVERY call, including directory and session revocation. */
  forSession(token: string) {
    this.#identity(token);
    const call = <T>(fn: (cid: string, orgId: string) => T): T => {
      const { cid, org } = this.#identity(token);
      return fn(cid, org.id);
    };
    const adminCall = <T>(fn: (cid: string, orgId: string) => T): T => {
      const { cid, org } = this.#identity(token);
      if (!org.admin) throw new LabyrinthError("forbidden", "Current CID organization admin required");
      return fn(cid, org.id);
    };
    return {
      repositories: () => call((cid, org) => this.#lab.repositories(cid, org)),
      createRepository: (name: string) => call((cid, org) => this.#lab.createRepository(cid, org, name)),
      commit: (repo: string, input: CommitInput) => call((cid, org) => this.#lab.commit(cid, org, repo, input)),
      readFile: (repo: string, commit: string, path: string) => call((cid, org) => this.#lab.readFile(cid, org, repo, commit, path)),
      history: (repo: string, branch?: string, limit?: number, before?: string) => call((cid, org) => this.#lab.history(cid, org, repo, branch, limit, before)),
      diff: (repo: string, from: string | null, to: string) => call((cid, org) => this.#lab.diff(cid, org, repo, from, to)),
      createBranch: (repo: string, name: string, from: string | null) => call((cid, org) => this.#lab.createBranch(cid, org, repo, name, from)),
      createTag: (repo: string, name: string, commit: string) => call((cid, org) => this.#lab.createTag(cid, org, repo, name, commit)),
      members: () => call((cid, org) => this.#lab.members(cid, org)),
      setMember: (member: string, role: Role | null) => adminCall((cid, org) => {
        // Labyrinth role is explicit, but the target must still belong to the same CID directory org.
        const target = role !== null ? this.#cid.organizationMembership(member) : null;
        if (role !== null && target?.id !== org) throw new LabyrinthError("forbidden", "Target is not a member of this client organization");
        if ((role === "owner" || role === "admin") && !target?.admin) throw new LabyrinthError("forbidden", "Administrative Labyrinth roles require a current CID org admin");
        return this.#lab.setMember(cid, org, member, role);
      }),
      audit: (after?: number, limit?: number) => adminCall((cid, org) => this.#lab.audit(cid, org, after, limit)),
    };
  }
  forProduct(token: string, product: string) {
    let id;
    try { id = labyrinthProduct(product); } catch { throw new LabyrinthError("invalid", "Unknown Labyrinth product"); }
    const session = this.forSession(token);
    const pathFor = (path: string) => {
      if (typeof path !== "string" || !path) throw new LabyrinthError("invalid", "Artifact path required");
      return `products/${id}/${path}`;
    };
    return {
      product: id,
      repositories: session.repositories, createRepository: session.createRepository,
      save: (repo: string, path: string, content: string | Uint8Array, expectedHead: string | null, message = `Save ${id} artifact`, branch = "main") => session.commit(repo, { branch, expectedHead, message, changes: { [pathFor(path)]: content } }),
      commit: (repo: string, input: CommitInput) => {
        if (!input || !input.changes || typeof input.changes !== "object" || Array.isArray(input.changes)) throw new LabyrinthError("invalid", "Artifact changes required");
        const changes: CommitInput["changes"] = Object.create(null);
        if (Object.keys(input.changes).length > 1000) throw new LabyrinthError("invalid", "Too many artifact changes");
        for (const [path, content] of Object.entries(input.changes)) changes[pathFor(path)] = content;
        return session.commit(repo, { ...input, changes });
      },
      remove: (repo: string, path: string, expectedHead: string, message = `Remove ${id} artifact`, branch = "main") => session.commit(repo, { branch, expectedHead, message, changes: { [pathFor(path)]: null } }),
      load: (repo: string, commit: string, path: string) => session.readFile(repo, commit, pathFor(path)),
      history: session.history, diff: session.diff,
    };
  }
}
