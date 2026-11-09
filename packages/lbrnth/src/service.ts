import { DEFAULT_LIMITS } from "./limits.ts";
import type { LabyrinthLimits } from "./limits.ts";
import { randomUUID } from "node:crypto";
import { assertExactOrigin, cumulusCorsHeaders, cumulusDomains, exactCorsOrigin } from "@infinitum/cid";
import { LabyrinthError, MemoryStorage } from "./model.ts";
import type { Commit, CommitInput, LabyrinthOptions, Organization, Repository, Role, Scope } from "./model.ts";
import { auditHash, commitHash, hashBytes, validName, validPath, verifyAudit } from "./integrity.ts";
const fail = (code: LabyrinthError["code"], message: string): never => { throw new LabyrinthError(code, message); };
const roles: Role[] = ["owner", "admin", "writer", "reader"];
const own = (record: object, key: string) => Object.hasOwn(record, key);
const approved = (value: unknown): boolean => {
  // Never authorize from an unresolved async authority; also avoid an unhandled rejection.
  if (value instanceof Promise) void value.catch(() => {});
  return value === true;
};

/** Trusted server-side SDK. Never expose this object, its callbacks or storage to a browser. */
export class Labyrinth {
  readonly #opts: LabyrinthOptions;
  readonly #storage;
  #orgs: Organization[];
  readonly #limits: LabyrinthLimits;
  readonly #corsOrigins: readonly string[];
  readonly #rates = new Map<string, { at: number; count: number }>();
  constructor(options: LabyrinthOptions) {
    this.#opts = options;
    this.#limits = { ...DEFAULT_LIMITS, ...options.limits };
    const configured = options.corsOrigins ?? cumulusDomains().corsOrigins;
    this.#corsOrigins = configured.map((origin) => {
      try {
        return assertExactOrigin(origin);
      } catch (err) {
        return fail("invalid", err instanceof Error ? err.message : "Invalid CORS origin");
      }
    });
    for (const key of Object.keys(DEFAULT_LIMITS) as (keyof LabyrinthLimits)[]) {
      const value = this.#limits[key];
      if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_LIMITS[key]) fail("invalid", "Invalid Labyrinth capacity limit");
    }
    this.#storage = options.storage ?? new MemoryStorage();
    this.#orgs = this.#storage.load();
    this.#checkCapacity(this.#orgs);
    for (const org of this.#orgs) {
      if (!verifyAudit(org.audit)) fail("integrity", "Invalid audit chain");
      for (const repo of org.repositories) {
        for (const [id, bytes] of Object.entries(repo.objects)) {
          if (hashBytes(Buffer.from(bytes, "base64")) !== id) fail("integrity", "Invalid object hash");
        }
        const seen = new Set<string>();
        for (const c of repo.commits) {
          if (c.id !== commitHash(c) || (c.parent !== null && !seen.has(c.parent)) || Object.values(c.tree).some(h => !own(repo.objects, h))) fail("integrity", "Invalid commit");
          seen.add(c.id);
        }
        if ([...Object.values(repo.branches), ...Object.values(repo.tags)].some(id => id !== null && !seen.has(id))) fail("integrity", "Invalid ref");
      }
    }
  }
  #at() { return (this.#opts.clock?.() ?? new Date()).toISOString(); }
  /** Allowlisted origin for a browser call, or null. Never "*". */
  corsAllowOrigin(requestOrigin: string | undefined): string | null {
    return exactCorsOrigin(requestOrigin, this.#corsOrigins);
  }
  /** CORS headers for a host exposing Labyrinth. Allow-Origin is set only for an exact match. */
  corsHeaders(requestOrigin: string | undefined): Record<string, string> {
    return cumulusCorsHeaders(requestOrigin, this.#corsOrigins);
  }
  #gate(cid: string, orgId: string, scope: Scope) {
    if (!approved(this.#opts.entitled(orgId, "LBRNTH")) || !approved(this.#opts.can(cid, "LBRNTH", scope))) fail("forbidden", "Labyrinth access denied");
  }
  #authorize(cid: string, orgId: string, scope: Scope): Organization {
    this.#gate(cid, orgId, scope);
    const org = this.#orgs.find(o => o.id === orgId);
    const member = org?.members.find(m => m.cid === cid);
    // Same response for missing org and non-member: no cross-client enumeration.
    if (!org || !member) return fail("forbidden", "Labyrinth access denied");
    if (scope === "repo:admin" && !["owner", "admin"].includes(member.role)) fail("forbidden", "Administrator required");
    if (scope === "repo:write" && member.role === "reader") fail("forbidden", "Writer required");
    const now = (this.#opts.clock?.() ?? new Date()).getTime();
    const rate = this.#rates.get(orgId);
    if (!rate || now - rate.at >= 60000) this.#rates.set(orgId, { at: now, count: 1 });
    else {
      if (rate.count >= this.#limits.operationsPerMinute) fail("capacity", "Organization request budget exhausted; retry after one minute");
      rate.count++;
    }
    return org;
  }
  #checkCapacity(orgs: Organization[]) {
    if (orgs.length > this.#limits.organizations) fail("capacity", "Organization capacity exceeded");
    let total = 0;
    for (const org of orgs) {
      if (org.repositories.length > this.#limits.repositoriesPerOrg || org.members.length > this.#limits.membersPerOrg || org.audit.length > this.#limits.auditEntriesPerOrg) fail("capacity", "Client organization capacity exceeded");
      for (const repo of org.repositories) {
        if (repo.commits.length > this.#limits.commitsPerRepository || Object.keys(repo.branches).length + Object.keys(repo.tags).length > this.#limits.refsPerRepository || repo.commits.some(c => Object.keys(c.tree).length > this.#limits.pathsPerCommit)) fail("capacity", "Repository capacity exceeded");
      }
      const size = Buffer.byteLength(JSON.stringify(org)); total += size;
      if (size > this.#limits.orgBytes || total > this.#limits.totalBytes) fail("capacity", "Labyrinth snapshot byte budget exceeded");
    }
  }
  #audit(org: Organization, actor: string, action: string, repoId?: string) {
    const e = { sequence: org.audit.length + 1, actor, action, repoId, at: this.#at(), previous: org.audit.at(-1)?.hash ?? null };
    org.audit.push({ ...e, hash: auditHash(e) });
  }
  #save(org: Organization) {
    const next = this.#orgs.filter(o => o.id !== org.id).concat(org);
    this.#checkCapacity(next);
    this.#storage.save(next); // no in-memory publication if persistence fails
    this.#orgs = next;
  }
  #run<T>(cid: string, orgId: string, scope: Scope, action: string, fn: (org: Organization) => T, repoId?: string, preflight?: () => void): T {
    const authorized = this.#authorize(cid, orgId, scope);
    preflight?.();
    const org = structuredClone(authorized);
    const result = fn(org);
    this.#audit(org, cid, action, repoId);
    this.#save(org);
    return structuredClone(result);
  }
  #repo(org: Organization, repoId: string) { return org.repositories.find(r => r.id === repoId) ?? fail("not_found", "Repository not found"); }
  #commit(repo: Repository, id: string) { return repo.commits.find(c => c.id === id) ?? fail("not_found", "Commit not found"); }
  #summary(repo: Repository) {
    return { id: repo.id, name: repo.name, visibility: repo.visibility, createdAt: repo.createdAt, branches: repo.branches, tags: repo.tags };
  }
  createOrganization(cid: string, orgId: string, name: string) {
    this.#gate(cid, orgId, "repo:admin");
    if (!approved(this.#opts.canProvision(cid, orgId))) fail("forbidden", "Organization provision denied");
    validName(orgId);
    if (typeof name !== "string" || !name.trim() || name.length > 120) fail("invalid", "Organization name required");
    if (this.#orgs.some(o => o.id === orgId)) fail("conflict", "Organization already provisioned");
    const org: Organization = { id: orgId, name, members: [{ cid, role: "owner" }], repositories: [], audit: [] };
    this.#audit(org, cid, "organization.create"); this.#save(org);
    return { id: org.id, name: org.name };
  }
  members(cid: string, orgId: string) {
    return this.#run(cid, orgId, "repo:read", "members.read", o => o.members);
  }
  setMember(cid: string, orgId: string, memberCid: string, role: Role | null) {
    return this.#run(cid, orgId, "repo:admin", `member.${role === null ? "remove" : "set"}:${memberCid}:${role ?? "none"}`, org => {
      if (typeof memberCid !== "string" || !memberCid || memberCid.length > 200 || (role !== null && !roles.includes(role))) fail("invalid", "Invalid membership");
      const actor = org.members.find(m => m.cid === cid)!;
      const current = org.members.find(m => m.cid === memberCid);
      if ((role === "owner" || current?.role === "owner") && actor.role !== "owner") fail("forbidden", "Owner required");
      if (current?.role === "owner" && role !== "owner" && org.members.filter(m => m.role === "owner").length === 1) fail("conflict", "Keep at least one owner");
      org.members = org.members.filter(m => m.cid !== memberCid);
      if (role) org.members.push({ cid: memberCid, role });
    });
  }
  createRepository(cid: string, orgId: string, name: string) {
    return this.#run(cid, orgId, "repo:write", "repository.create", org => {
      validName(name);
      if (org.repositories.some(r => r.name === name)) fail("conflict", "Repository name exists");
      const repo: Repository = { id: randomUUID(), name, visibility: "private", createdAt: this.#at(), branches: { main: null }, tags: {}, commits: [], objects: {} };
      org.repositories.push(repo);
      return this.#summary(repo);
    });
  }
  repositories(cid: string, orgId: string) {
    return this.#run(cid, orgId, "repo:read", "repositories.read", org => org.repositories.map(r => this.#summary(r)));
  }
  #preflightCommit(input: CommitInput): void {
    // Called after authorization, before snapshot cloning or allocating content buffers.
    if (!input || typeof input !== "object" || !input.changes || typeof input.changes !== "object" || Array.isArray(input.changes)) fail("invalid", "Commit changes must be a path map");
    let count = 0; let bytes = 0;
    for (const path in input.changes) {
      if (!own(input.changes, path)) continue;
      if (++count > 1000) fail("invalid", "Commit needs 1–1000 path changes");
      validPath(path);
      const value = input.changes[path];
      if (value === null) continue;
      if (typeof value !== "string" && !(value instanceof Uint8Array)) fail("invalid", "Content must be text or bytes");
      bytes += typeof value === "string" ? Buffer.byteLength(value) : value.byteLength;
      if (bytes > 10 * 1024 * 1024) fail("invalid", "Commit exceeds 10 MiB");
    }
  }
  commit(cid: string, orgId: string, repoId: string, input: CommitInput): Commit {
    return this.#run(cid, orgId, "repo:write", "commit.create", org => {
      const repo = this.#repo(org, repoId); validName(input.branch);
      if (!own(repo.branches, input.branch)) fail("not_found", "Branch not found");
      const parent = repo.branches[input.branch];
      if (input.expectedHead !== parent) fail("conflict", "Branch head changed; reload before committing");
      if (typeof input.message !== "string" || !input.message.trim() || input.message.length > 4000) fail("invalid", "Commit message required (up to 4000 characters)");
      const tree: Record<string, string> = parent ? { ...this.#commit(repo, parent).tree } : {};
      const entries = Object.entries(input.changes);
      if (entries.length === 0 || entries.length > 1000) fail("invalid", "Commit needs 1–1000 path changes");
      let total = 0;
      for (const [path, value] of entries) {
        validPath(path);
        if (value === null) { delete tree[path]; continue; }
        if (typeof value !== "string" && !(value instanceof Uint8Array)) fail("invalid", "Content must be text or bytes");
        const bytes = Buffer.from(value); total += bytes.length;
        if (total > 10 * 1024 * 1024) fail("invalid", "Commit exceeds 10 MiB");
        const id = hashBytes(bytes); repo.objects[id] = bytes.toString("base64"); tree[path] = id;
      }
      const paths = Object.keys(tree).sort();
      // A file cannot also be a directory, even if intervening sorted names exist.
      for (const path of paths) {
        const parts = path.split("/");
        for (let i = 1; i < parts.length; i++) if (own(tree, parts.slice(0, i).join("/"))) fail("invalid", "File/directory collision");
      }
      const data = { parent, tree, author: cid, message: input.message, at: this.#at() };
      const commit = { ...data, id: commitHash(data) };
      if (!repo.commits.some(c => c.id === commit.id)) repo.commits.push(commit);
      repo.branches[input.branch] = commit.id;
      return commit;
    }, repoId, () => this.#preflightCommit(input));
  }
  createBranch(cid: string, orgId: string, repoId: string, name: string, commitId: string | null) {
    return this.#run(cid, orgId, "repo:write", `branch.create:${name}`, org => {
      validName(name); const repo = this.#repo(org, repoId);
      if (own(repo.branches, name)) fail("conflict", "Branch exists");
      if (commitId !== null) this.#commit(repo, commitId);
      repo.branches[name] = commitId;
    }, repoId);
  }
  createTag(cid: string, orgId: string, repoId: string, name: string, commitId: string) {
    return this.#run(cid, orgId, "repo:write", `tag.create:${name}`, org => {
      validName(name); const repo = this.#repo(org, repoId); this.#commit(repo, commitId);
      if (own(repo.tags, name)) fail("conflict", "Tags are immutable");
      repo.tags[name] = commitId;
    }, repoId);
  }
  history(cid: string, orgId: string, repoId: string, branch = "main", limit = 100): Commit[] {
    return this.#run(cid, orgId, "repo:read", "history.read", org => {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) fail("invalid", "History limit is 1–1000");
      const repo = this.#repo(org, repoId);
      if (!own(repo.branches, branch)) fail("not_found", "Branch not found");
      const commits: Commit[] = []; let id = repo.branches[branch];
      while (id && commits.length < limit) { const c = this.#commit(repo, id); commits.push(c); id = c.parent; }
      return commits;
    }, repoId);
  }
  readFile(cid: string, orgId: string, repoId: string, commitId: string, path: string): Uint8Array {
    return this.#run(cid, orgId, "repo:read", "object.read", org => {
      validPath(path); const repo = this.#repo(org, repoId); const c = this.#commit(repo, commitId);
      if (!own(c.tree, path)) fail("not_found", "Path not found");
      const bytes = Buffer.from(repo.objects[c.tree[path]], "base64");
      if (hashBytes(bytes) !== c.tree[path]) fail("integrity", "Object hash mismatch");
      return bytes;
    }, repoId);
  }
  /** Content-addressed file diff. No binary data is coerced into text. null = empty tree. */
  diff(cid: string, orgId: string, repoId: string, from: string | null, to: string) {
    return this.#run(cid, orgId, "repo:read", "diff.read", org => {
      const repo = this.#repo(org, repoId); const before = from === null ? {} : this.#commit(repo, from).tree;
      const after = this.#commit(repo, to).tree;
      return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap(path => {
        const oldHash = own(before, path) ? before[path] : null;
        const newHash = own(after, path) ? after[path] : null;
        return oldHash === newHash ? [] : [{ path, before: oldHash, after: newHash, kind: oldHash === null ? "added" : newHash === null ? "deleted" : "modified" }];
      });
    }, repoId);
  }
  /** Trusted auth adapter records credential issuance without storing any bearer in audit. */
  recordCredentialIssue(cid: string, orgId: string) {
    this.#run(cid, orgId, "repo:read", "credential.issue", () => undefined);
  }
  audit(cid: string, orgId: string) {
    return this.#run(cid, orgId, "repo:admin", "audit.read", org => [...org.audit]);
  }
  /** @deprecated Trusted server-internal API only; use CidLabyrinth.forSession for real CID authentication.
   * Bind only an authenticated CID. Host products can share this SDK without trusting client claims. */
  forClient(cid: string, orgId: string) {
    return {
      repositories: () => this.repositories(cid, orgId),
      createRepository: (name: string) => this.createRepository(cid, orgId, name),
      commit: (repo: string, input: CommitInput) => this.commit(cid, orgId, repo, input),
      readFile: (repo: string, commit: string, path: string) => this.readFile(cid, orgId, repo, commit, path),
      history: (repo: string, branch?: string, limit?: number) => this.history(cid, orgId, repo, branch, limit),
      diff: (repo: string, from: string | null, to: string) => this.diff(cid, orgId, repo, from, to),
      createBranch: (repo: string, name: string, from: string | null) => this.createBranch(cid, orgId, repo, name, from),
      createTag: (repo: string, name: string, commit: string) => this.createTag(cid, orgId, repo, name, commit),
    };
  }
}
