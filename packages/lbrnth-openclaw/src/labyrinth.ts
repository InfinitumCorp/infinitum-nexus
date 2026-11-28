/**
 * Minimal Labyrinth API client for the OpenClaw plugin. It speaks the public relay contract
 * (POST /api/labyrinth, bearer only, `x-labyrinth: 1`) and pins the product to `openclaw`, so the
 * server confines every write to `products/openclaw/…` in the person's repositories.
 *
 * The credential is a short-lived, repository-only `lbrnth_…` bearer that the person issues from
 * their Cumulus ID session (id.cumuluscloud.app/labyrinth). It is never logged, echoed or returned.
 */
export const LABYRINTH_PRODUCT = "openclaw";
export const DEFAULT_ENDPOINT = "https://id.cumuluscloud.app/api/labyrinth";
const TIMEOUT_MS = 15_000;
const MAX_CONTENT = 1024 * 1024; // the relay limit is 2 MiB of JSON; keep text artifacts well under it

export class LabyrinthToolError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "LabyrinthToolError";
    this.status = status;
  }
}

export interface LabyrinthSettings {
  /** HTTPS relay endpoint. Default: Cumulus ID (https://id.cumuluscloud.app/api/labyrinth). */
  endpoint?: string;
  /** `lbrnth_…` bearer. Falls back to the LBRNTH_TOKEN environment variable. */
  token?: string;
}

export interface RepositorySummary {
  id: string;
  name: string;
  branches: Record<string, string | null>;
}

export interface CommitSummary {
  id: string;
  parent: string | null;
  message: string;
  at: string;
  /** Paths this product owns in the commit's tree, without the `products/openclaw/` prefix. */
  paths: string[];
}

type Fetch = typeof fetch;

const PREFIX = `products/${LABYRINTH_PRODUCT}/`;

function endpointOf(settings: LabyrinthSettings): string {
  const endpoint = settings.endpoint?.trim() || DEFAULT_ENDPOINT;
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new LabyrinthToolError(400, "Labyrinth endpoint is not a valid URL"); }
  if (url.protocol !== "https:" || url.username || url.password) throw new LabyrinthToolError(400, "Labyrinth endpoint must be an https:// URL without credentials");
  return url.toString();
}

function tokenOf(settings: LabyrinthSettings, env: Record<string, string | undefined>): string {
  const token = (settings.token ?? env.LBRNTH_TOKEN ?? "").trim();
  if (!/^lbrnth_[A-Za-z0-9_-]{16,256}$/.test(token)) {
    throw new LabyrinthToolError(401, "No Labyrinth credential. Issue one at https://id.cumuluscloud.app/labyrinth and set LBRNTH_TOKEN (it lasts 15 minutes).");
  }
  return token;
}

const text = (value: unknown, name: string, max = 4000): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new LabyrinthToolError(400, `${name} is required`);
  return value;
};

/** Artifact paths are relative to this product's folder; no traversal or absolute paths. */
export function artifactPath(value: unknown): string {
  const path = text(value, "path", 512).replace(/\\/g, "/");
  if (path.startsWith("/") || path.split("/").some(part => part === "" || part === "." || part === "..")) {
    throw new LabyrinthToolError(400, "path must be a relative path such as notes/today.md");
  }
  return path;
}

export class LabyrinthTools {
  readonly #endpoint: string;
  readonly #token: string;
  readonly #fetch: Fetch;

  constructor(settings: LabyrinthSettings, options: { fetch?: Fetch; env?: Record<string, string | undefined> } = {}) {
    this.#endpoint = endpointOf(settings);
    this.#token = tokenOf(settings, options.env ?? process.env);
    this.#fetch = options.fetch ?? fetch;
  }

  async #call<T>(action: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const response = await this.#fetch(this.#endpoint, {
      method: "POST",
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { authorization: `Bearer ${this.#token}`, "content-type": "application/json", "x-labyrinth": "1" },
      body: JSON.stringify({ ...body, product: LABYRINTH_PRODUCT, action }),
    });
    let payload: unknown;
    try { payload = await response.json(); } catch { payload = undefined; }
    if (!response.ok) {
      const reason = payload && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string" ? (payload as { error: string }).error : `HTTP ${response.status}`;
      const hint = response.status === 401 || response.status === 403 ? " Issue a new credential at https://id.cumuluscloud.app/labyrinth." : response.status === 409 ? " The file changed since it was read; read it again and retry." : "";
      throw new LabyrinthToolError(response.status, `Labyrinth: ${reason.slice(0, 200)}.${hint}`);
    }
    return payload as T;
  }

  async repositories(signal?: AbortSignal): Promise<RepositorySummary[]> {
    const list = await this.#call<RepositorySummary[]>("list", {}, signal);
    return list.map(r => ({ id: r.id, name: r.name, branches: r.branches }));
  }

  async #repository(repo: string, signal?: AbortSignal): Promise<RepositorySummary> {
    const wanted = text(repo, "repo", 200);
    const found = (await this.repositories(signal)).find(r => r.id === wanted || r.name === wanted);
    if (!found) throw new LabyrinthToolError(404, `Labyrinth: no repository named ${JSON.stringify(wanted.slice(0, 80))}`);
    return found;
  }

  async read(repo: string, path: string, branch = "main", signal?: AbortSignal): Promise<{ repo: string; branch: string; commit: string; path: string; content: string }> {
    const relative = artifactPath(path);
    const target = await this.#repository(repo, signal);
    const commit = target.branches[text(branch, "branch", 200)];
    if (!commit) throw new LabyrinthToolError(404, `Labyrinth: branch ${JSON.stringify(branch)} has no commits`);
    const { content } = await this.#call<{ content: string }>("load", { repo: target.id, commit, path: relative }, signal);
    return { repo: target.name, branch, commit, path: relative, content };
  }

  async save(repo: string, path: string, content: string, message?: string, branch = "main", signal?: AbortSignal): Promise<{ repo: string; branch: string; commit: string; path: string }> {
    const relative = artifactPath(path);
    if (typeof content !== "string") throw new LabyrinthToolError(400, "content is required");
    if (Buffer.byteLength(content) > MAX_CONTENT) throw new LabyrinthToolError(413, "content is larger than 1 MiB");
    const target = await this.#repository(repo, signal);
    const name = text(branch, "branch", 200);
    if (!Object.hasOwn(target.branches, name)) throw new LabyrinthToolError(404, `Labyrinth: no branch ${JSON.stringify(name)}`);
    const commit = await this.#call<{ id: string }>("save", {
      repo: target.id, path: relative, content, expectedHead: target.branches[name], branch: name,
      ...(message === undefined ? {} : { message: text(message, "message", 500) }),
    }, signal);
    return { repo: target.name, branch: name, commit: commit.id, path: relative };
  }

  async history(repo: string, branch = "main", limit = 20, signal?: AbortSignal): Promise<CommitSummary[]> {
    const target = await this.#repository(repo, signal);
    const n = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 20;
    const commits = await this.#call<Array<{ id: string; parent: string | null; message: string; at: string; tree?: Record<string, string> }>>(
      "history", { repo: target.id, branch: text(branch, "branch", 200), limit: n }, signal);
    // Only this product's paths are shown to the agent; other products' file names stay out of the model.
    return commits.map(c => ({ id: c.id, parent: c.parent, message: c.message, at: c.at,
      paths: Object.keys(c.tree ?? {}).filter(p => p.startsWith(PREFIX)).map(p => p.slice(PREFIX.length)).sort() }));
  }
}
