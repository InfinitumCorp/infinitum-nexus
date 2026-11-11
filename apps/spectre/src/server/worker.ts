import { createServer } from "node:http";
import { httpServerHandler } from "cloudflare:node";
import { DurableObject } from "cloudflare:workers";
import type { Entry } from "@infinitum/firmament";
import type { WorkersAiBinding } from "@infinitum/ai";
import handler, { useGateway } from "./vercel.ts";
import { useWorkersAi } from "./ai.ts";
import { ConflictError, type DocRow, type NexusGateway } from "./remote.ts";
import { initSchema, loadState, commitState, type CommitResult } from "./do-store.ts";
import { STATIC_ASSET_CSP } from "./static-policy.ts";

/**
 * Cumulus://ID (+SPCTR) on Cloudflare Workers at id.cumuluscloud.app, free plan.
 * scripts/build-cloudflare.mjs bundles public/ into the Worker (dist/entry.mjs) and serves it
 * with serveStatic(); /api/* reaches the same hosted handler as the Vercel build through Workers'
 * Node.js HTTP server support. State (Firmament ledger + CID and
 * Spectre stores) lives in one SQLite-backed Durable Object, NexusStore, with the same
 * all-or-nothing commit rules as the Supabase nexus-store function.
 * Configuration: wrangler.jsonc (vars, NexusStore, the free AI binding) and Worker secrets
 * (FIRMAMENT_SIGNER_KEY, COGNITO_CLIENT_SECRET, optional GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET,
 * and CID_OIDC_SIGNING_KEY). OpenID Connect stays off when CID_OIDC_SIGNING_KEY is unset.
 * Ask Spectre uses the AI binding, then OMNIROUTE_*. See docs/cumulus-id.md.
 */
const PORT = 8080;
createServer((req, res) => void handler(req, res)).listen(PORT);
const http = httpServerHandler({ port: PORT });

interface NexusStoreStub {
  load(since: number, versions: Record<string, number>): Promise<{ entries: Entry[]; docs: DocRow[] }>;
  commit(entries: Entry[], docs: { id: string; expected: number; data: Record<string, unknown> }[]): Promise<CommitResult>;
}
interface Env {
  NEXUS_STATE: { idFromName(name: string): unknown; get(id: unknown): NexusStoreStub };
  /** Free Workers AI binding (`ai.binding` = AI in wrangler.jsonc). Absent when the binding is not declared. */
  AI?: WorkersAiBinding;
}

export class NexusStore extends DurableObject<Env> {
  constructor(ctx: ConstructorParameters<typeof DurableObject<Env>>[0], env: Env) {
    super(ctx, env);
    initSchema(ctx.storage.sql);
  }
  async load(since: number, versions: Record<string, number>) {
    return loadState(this.ctx.storage.sql, since, versions);
  }
  async commit(entries: Entry[], docs: { id: string; expected: number; data: Record<string, unknown> }[]) {
    return commitState(this.ctx.storage.sql, entries, docs, (fn) => this.ctx.storage.transactionSync(fn));
  }
}

/**
 * Talks to the NexusStore Durable Object. A stub is made per call: Workers forbid using I/O
 * objects (a stub included) from a request other than the one that created them.
 */
class DurableGateway implements NexusGateway {
  private readonly ns: Env["NEXUS_STATE"];
  constructor(ns: Env["NEXUS_STATE"]) {
    this.ns = ns;
  }
  private stub() {
    return this.ns.get(this.ns.idFromName("cumulus-id"));
  }
  load(since: number, versions: Record<string, number>) {
    return this.stub().load(since, versions);
  }
  async commit(entries: Entry[], docs: { id: string; expected: number; data: Record<string, unknown> }[]) {
    const result = await this.stub().commit(entries, docs);
    if (!result.ok) throw new ConflictError();
    return result.versions;
  }
}

let configured = false;
function configure(env: Env) {
  // Refresh the binding each request. The router calls through to whatever is current.
  if (env.AI) useWorkersAi(env.AI);
  if (configured) return;
  useGateway(new DurableGateway(env.NEXUS_STATE));
  configured = true;
}

/** A file from public/, embedded at build time. */
export interface StaticFile {
  type: string;
  /** base64 */
  body: string;
}

/** Static files use the live host's CSP. Framing stays denied, including form.html and book.html. */
function staticHeaders(path: string, type: string): Headers {
  return new Headers({
    "Content-Type": type,
    "Cache-Control": path === "/index.html" ? "no-cache" : "public, max-age=300",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
    "Content-Security-Policy": STATIC_ASSET_CSP,
  });
}

/** Serve an embedded public/ file, or undefined to let the app handle the request. */
export function serveStatic(request: Request, files: Record<string, StaticFile>): Response | undefined {
  if (request.method !== "GET" && request.method !== "HEAD") return undefined;
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) return undefined;
  const path = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = files[path];
  if (!file) return undefined;
  const body = request.method === "HEAD" ? null : Uint8Array.from(atob(file.body), (c) => c.charCodeAt(0));
  return new Response(body, { status: 200, headers: staticHeaders(path, file.type) });
}

export function handleRequest(request: Request, env: Env, ctx: unknown, files: Record<string, StaticFile> = {}) {
  const hit = serveStatic(request, files);
  if (hit) return hit;
  configure(env);
  return http.fetch(request, env, ctx);
}

export default {
  fetch(request: Request, env: Env, ctx: unknown) {
    return handleRequest(request, env, ctx);
  },
};
