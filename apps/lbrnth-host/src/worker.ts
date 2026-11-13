import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import { LabyrinthHost, RemoteCidDirectory } from "@infinitum/lbrnth";
import type { SqlDatabase, SqlQueryable } from "@infinitum/lbrnth";
// Not re-exported from the package index; same helpers the Node handler uses.
import { LABYRINTH_HTTP_LIMIT, labyrinthToken } from "../../../packages/lbrnth/src/http.ts";

/**
 * Labyrinth *LBRNTH hosted service on Cloudflare Workers: the US copy for users outside Russia.
 * Same LabyrinthHost as the Node service (main.ts); only the transport differs.
 *
 *   HYPERDRIVE          Supabase Postgres (role lbrnth_host, schema lbrnth), caching off
 *   CID                 service binding to the cumulus-id Worker (id.cumuluscloud.app)
 *   LBRNTH_MASTER_KEY   secret: canonical base64, 32 bytes. Not the Russia server's key
 *   CID_DIRECTORY_KEY   secret: this host's key for POST /api/id/labyrinth-directory
 *   LBRNTH_ENTITLED_ORGS optional comma-separated operator allowlist of CID org ids
 *
 * Paths: POST /api/labyrinth (bearer only, no cookies, no CORS), GET /health, else 404.
 */
export interface Env {
  HYPERDRIVE: { connectionString: string };
  CID?: { fetch: typeof fetch };
  LBRNTH_MASTER_KEY?: string;
  CID_DIRECTORY_KEY?: string;
  CID_DIRECTORY_URL?: string;
  LBRNTH_ENTITLED_ORGS?: string;
}

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "strict-transport-security": "max-age=63072000; includeSubDomains",
  "x-robots-tag": "noindex, nofollow",
  "cache-control": "no-store",
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...SECURITY_HEADERS, "content-type": "application/json" } });

/** One Postgres connection per request (Hyperdrive pools them); Workers can't share I/O across requests. */
const requestClient = new AsyncLocalStorage<() => Promise<pg.Client>>();

function currentClient(): Promise<pg.Client> {
  const get = requestClient.getStore();
  if (!get) throw new Error("Labyrinth host: database used outside a request");
  return get();
}

const wrap = (client: () => Promise<pg.Client>): SqlQueryable => ({
  query: async <R>(text: string, params?: unknown[]) => ({ rows: (await (await client()).query(text, params as unknown[])).rows as R[] }),
});

/** SqlDatabase over the current request's client; transactions run on that same client. */
export const requestDatabase: SqlDatabase = {
  ...wrap(currentClient),
  async transaction(fn) {
    const client = await currentClient();
    await client.query("begin");
    try {
      const result = await fn(wrap(async () => client));
      await client.query("commit");
      return result;
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    }
  },
};

/** fetch for RemoteCidDirectory: Workers refuse redirect "error", so refuse redirects here instead. */
export function directoryFetch(binding: Env["CID"]): typeof fetch {
  return async (input, init) => {
    const call = binding ? binding.fetch.bind(binding) : fetch;
    const res = await call(input as string, { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) { await res.body?.cancel(); throw new TypeError("redirect refused"); }
    return res;
  };
}

let cached: { key: string; host: LabyrinthHost } | undefined;

/** One LabyrinthHost per isolate (its envelope cache survives between requests); rebuilt if config changes. */
function hostFor(env: Env): LabyrinthHost | undefined {
  const encoded = env.LBRNTH_MASTER_KEY, directoryKey = env.CID_DIRECTORY_KEY;
  if (!encoded || !directoryKey || !env.HYPERDRIVE?.connectionString) return undefined;
  const key = `${encoded}|${directoryKey}|${env.CID_DIRECTORY_URL ?? ""}`;
  if (cached?.key === key) return cached.host;
  const masterKey = Buffer.from(encoded, "base64");
  if (masterKey.length !== 32 || masterKey.toString("base64") !== encoded) throw new Error("LBRNTH_MASTER_KEY must be a canonical base64 32-byte secret");
  const host = new LabyrinthHost({
    db: requestDatabase,
    masterKey: new Uint8Array(masterKey),
    directory: new RemoteCidDirectory(env.CID_DIRECTORY_URL || "https://id.cumuluscloud.app/api/id/labyrinth-directory", directoryKey, directoryFetch(env.CID)),
    entitledOrgs: () => (env.LBRNTH_ENTITLED_ORGS ?? "").split(",").map(x => x.trim()).filter(Boolean),
  });
  cached = { key, host };
  return host;
}

async function readCommand(request: Request): Promise<unknown | Response> {
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > LABYRINTH_HTTP_LIMIT) { await reader.cancel(); return json(413, { error: "Labyrinth request too large" }); }
    chunks.push(value);
  }
  try { return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))); } catch { return json(400, { error: "Labyrinth request denied" }); }
}

export async function handle(request: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
  const path = new URL(request.url).pathname;
  let host: LabyrinthHost | undefined;
  try { host = hostFor(env); } catch (err) { console.error("Labyrinth host: bad configuration", err instanceof Error ? err.message : err); }
  if (path === "/health" && (request.method === "GET" || request.method === "HEAD")) return json(200, { ok: true, configured: Boolean(host), region: "us" });
  if (path !== "/api/labyrinth") return json(404, { error: "Not found" });
  if (!host) return json(503, { error: "Labyrinth is not configured" });
  if (request.method !== "POST") return json(405, { error: "POST required" });
  if (request.headers.get("x-labyrinth") !== "1" || !request.headers.get("content-type")?.startsWith("application/json")) return json(403, { error: "JSON and Labyrinth request header required" });
  const authorization = request.headers.get("authorization");
  const token = authorization !== null ? labyrinthToken(authorization) : undefined;
  if (!token) return json(401, { error: "Cumulus ID sign-in required" });
  const command = await readCommand(request);
  if (command instanceof Response) return command;

  let client: Promise<pg.Client> | undefined;
  const open = () => client ??= (async () => {
    const c = new pg.Client({ connectionString: env.HYPERDRIVE.connectionString, statement_timeout: 15_000, application_name: "lbrnth-host-us" });
    await c.connect();
    return c;
  })();
  try {
    const out = await requestClient.run(open, () => host!.run(token, command));
    return json(out.status, out.body);
  } catch (err) {
    console.error("Labyrinth host: request failed", err instanceof Error ? err.message : err);
    return json(500, { error: "Labyrinth unavailable" });
  } finally {
    if (client) ctx.waitUntil(client.then(c => c.end()).catch(() => undefined));
  }
}

export default { fetch: handle };
