import type { LabyrinthLimits } from "./limits.ts";
/** Labyrinth — Infinitum Corporation®. No client repository is public. */
export const LBRNTH = Object.freeze({ id: "LBRNTH", name: "Labyrinth", wordmark: "Labyrinth *LBRNTH", publisher: "Infinitum Corporation®" } as const);
export type Role = "owner" | "admin" | "writer" | "reader";
export type Scope = "repo:read" | "repo:write" | "repo:admin";
export interface Member { cid: string; role: Role }
export interface Commit {
  id: string; parent: string | null; tree: Record<string, string>; author: string; message: string; at: string;
}
export interface Repository {
  id: string; name: string; visibility: "private"; createdAt: string;
  branches: Record<string, string | null>; tags: Record<string, string>;
  commits: Commit[]; objects: Record<string, string>;
}
export interface AuditEntry {
  sequence: number; actor: string; action: string; repoId?: string; at: string;
  previous: string | null; hash: string;
}
export interface Organization {
  id: string; name: string; members: Member[]; repositories: Repository[]; audit: AuditEntry[];
}
/** Synchronous, atomic whole-snapshot storage. A rejected save MUST leave the old snapshot intact. */
export interface LabyrinthStorage { load(): Organization[]; save(orgs: Organization[]): void }
export class MemoryStorage implements LabyrinthStorage {
  #state: Organization[] = [];
  load() { return structuredClone(this.#state); }
  save(orgs: Organization[]) { this.#state = structuredClone(orgs); }
}
export class LabyrinthError extends Error {
  readonly code: "forbidden" | "not_found" | "invalid" | "conflict" | "integrity" | "capacity";
  constructor(code: LabyrinthError["code"], message: string) { super(message); this.code = code; }
}
export interface LabyrinthOptions {
  /** Use cid.can.bind(cid). CID identity must come from a verified session, never request JSON. */
  can(cid: string, product: "LBRNTH", scope: Scope): boolean;
  /** Trusted billing/plan authority, independent of CID user-consent grants. Deny by default. */
  entitled(orgId: string, product: "LBRNTH"): boolean;
  /** Trusted org directory: may this CID provision THIS existing client organization? */
  canProvision(cid: string, orgId: string): boolean;
  storage?: LabyrinthStorage;
  clock?: () => Date;
  /** Optional lower per-client quotas. Values cannot exceed the package hard ceilings. */
  limits?: Partial<LabyrinthLimits>;
}
export interface CommitInput {
  branch: string;
  /** Mandatory compare-and-swap: null for the initial commit. Prevents lost updates. */
  expectedHead: string | null;
  message: string;
  /** UTF-8 text or bytes; null deletes a path. Paths are logical, never filesystem paths. */
  changes: Record<string, string | Uint8Array | null>;
}
