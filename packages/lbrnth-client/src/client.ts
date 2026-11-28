/** Browser/Worker-safe client. Never accepts CID/org claims as authentication. */
export interface RepositoryInfo { id: string; name: string; visibility: "private"; branches: Record<string, string | null>; tags: Record<string, string> }
export interface ArtifactCommit { id: string; parent: string | null; tree: Record<string, string>; author: string; message: string; at: string }
export interface EncodedArtifact { content: string; encoding: "utf-8" | "base64" }
export type ArtifactChanges = Record<string, string | EncodedArtifact | null>;
export type RepositoryRole = "owner" | "admin" | "writer" | "reader";
export interface RepositoryMember { cid: string; role: RepositoryRole }
export interface RepositoryAuditEntry { sequence: number; actor: string; action: string; repoId?: string; at: string; previous: string | null; hash: string }
export interface RepositorySession { cid: string; organization: { id: string; name: string; admin: boolean } | null; scopes: string[]; delegated: boolean }
export type LabyrinthCommand =
  | { action: "commit"; repo: string; changes: ArtifactChanges; expectedHead: string | null; message: string; branch?: string }
  | { action: "organization"; name: string }
  | { action: "session" }
  | { action: "branch"; repo: string; name: string; from: string | null }
  | { action: "tag"; repo: string; name: string; commit: string }
  | { action: "members" }
  | { action: "set-member"; member: string; memberRole: RepositoryRole | null }
  | { action: "audit"; after?: number; limit?: number }
  | { action: "remove"; repo: string; path: string; expectedHead: string; message?: string; branch?: string }
  | { action: "list" }
  | { action: "create"; name: string }
  | { action: "save"; repo: string; path: string; content: string; encoding?: "utf-8" | "base64"; expectedHead: string | null; message?: string; branch?: string }
  | { action: "load"; repo: string; commit: string; path: string; encoding?: "utf-8" | "base64" }
  | { action: "history"; repo: string; branch?: string; limit?: number; before?: string }
  | { action: "diff"; repo: string; from: string | null; to: string }
  | { action: "provision" }
  | { action: "token" }
  | { action: "consent"; scopes: ("repo:read" | "repo:write" | "repo:admin")[] };
export interface LabyrinthClientOptions {
  endpoint: string;
  /** Return a real opaque CID session token; never a product API key or an unverified CID. */
  token?: () => string | undefined | Promise<string | undefined>;
  fetch?: typeof fetch;
}
export function secureLabyrinthEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.username || url.password || url.search || url.hash || !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("Labyrinth requires HTTPS (loopback HTTP only for development)");
  return url.href;
}
/**
 * Picks the hosted Labyrinth for a visitor's country. `spec` is either one URL, or a map such as
 * "RU=https://lbrnth.cumuluscloud.app/api/labyrinth,*=https://lbrnth-us.cumuluscloud.app/api/labyrinth"
 * (Russia on the Russia server, everyone else on the US one). `country` is Cloudflare's
 * cf-ipcountry value. A map with no matching entry and no "*" yields undefined (not configured).
 */
export function labyrinthEndpointFor(spec: string, country: string | null | undefined): string | undefined {
  if (!spec.includes("=")) return spec;
  const routes = new Map<string, string>();
  for (const part of spec.split(",")) {
    const i = part.indexOf("=");
    if (i < 1) throw new Error("Invalid Labyrinth endpoint map");
    const code = part.slice(0, i).trim().toUpperCase();
    if (!(code === "*" || /^[A-Z]{2}$/.test(code))) throw new Error("Invalid Labyrinth endpoint map");
    routes.set(code, part.slice(i + 1).trim());
  }
  const cc = (country ?? "").trim().toUpperCase();
  return (/^[A-Z]{2}$/.test(cc) ? routes.get(cc) : undefined) ?? routes.get("*");
}
export function createLabyrinthClient(product: string, options: LabyrinthClientOptions) {
  const endpoint = secureLabyrinthEndpoint(options.endpoint);
  const send = async <T>(command: LabyrinthCommand): Promise<T> => {
    const token = await options.token?.();
    const headers: Record<string, string> = { "content-type": "application/json", "x-labyrinth": "1" };
    if (token) {
      if (!/^[^\s]{1,512}$/.test(token)) throw new Error("Invalid CID session token");
      headers.authorization = `Bearer ${token}`;
    }
    const response = await (options.fetch ?? fetch)(endpoint, { method: "POST", headers, body: JSON.stringify({ ...command, product }), credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Labyrinth request denied (${response.status})`);
    return await response.json() as T;
  };
  return {
    product,
    commit: (repo: string, changes: ArtifactChanges, expectedHead: string | null, message: string, branch?: string) => send<ArtifactCommit>({ action: "commit", repo, changes, expectedHead, message, branch }),
    saveArtifact: (repo: string, path: string, artifact: EncodedArtifact, expectedHead: string | null, message?: string, branch?: string) => send<ArtifactCommit>({ action: "save", repo, path, ...artifact, expectedHead, message, branch }),
    loadArtifact: (repo: string, commit: string, path: string) => send<EncodedArtifact>({ action: "load", repo, commit, path, encoding: "base64" }),
    createOrganization: (name: string) => send<{ id: string; name: string }>({ action: "organization", name }),
    session: () => send<RepositorySession>({ action: "session" }),
    createBranch: (repo: string, name: string, from: string | null) => send<void>({ action: "branch", repo, name, from }),
    createTag: (repo: string, name: string, commit: string) => send<void>({ action: "tag", repo, name, commit }),
    members: () => send<RepositoryMember[]>({ action: "members" }),
    setMember: (member: string, memberRole: RepositoryRole | null) => send<void>({ action: "set-member", member, memberRole }),
    audit: (after?: number, limit?: number) => send<RepositoryAuditEntry[]>({ action: "audit", after, limit }),
    remove: (repo: string, path: string, expectedHead: string, message?: string, branch?: string) => send<ArtifactCommit>({ action: "remove", repo, path, expectedHead, message, branch }),
    repositories: () => send<RepositoryInfo[]>({ action: "list" }),
    createRepository: (name: string) => send<RepositoryInfo>({ action: "create", name }),
    save: (repo: string, path: string, content: string, expectedHead: string | null, message?: string, branch?: string) => send<ArtifactCommit>({ action: "save", repo, path, content, expectedHead, message, branch }),
    load: async (repo: string, commit: string, path: string) => (await send<{ content: string }>({ action: "load", repo, commit, path })).content,
    history: (repo: string, branch?: string, limit?: number, before?: string) => send<ArtifactCommit[]>({ action: "history", repo, branch, limit, before }),
    diff: (repo: string, from: string | null, to: string) => send<{ path: string; before: string | null; after: string | null; kind: string }[]>({ action: "diff", repo, from, to }),
    /** User-invoked consent only; requires direct CID login, not a repository token. */
    consent: (scopes: ("repo:read" | "repo:write" | "repo:admin")[]) => send<unknown>({ action: "consent", scopes }),
    /** Same-origin CID cookie only; keep the returned repository-only bearer in memory. */
    sessionToken: () => send<{ token: string; expiresAt: string }>({ action: "token" }),
    provision: () => send<{ id: string; name: string }>({ action: "provision" }),
  };
}
