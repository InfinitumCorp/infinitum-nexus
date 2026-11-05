/**
 * METATRON HTTP API.
 * Run: node src/server.ts   (Node 22.18+, TypeScript runs directly)
 *
 * Auth: Authorization: Bearer <Cumulus://ID session token>
 *
 * GET    /health
 * GET    /link                          Hosted Plaid Link page (opened with #code=...)
 * POST   /link/token     {code, investments?}
 * POST   /link/exchange  {code, publicToken, institution}
 * POST   /webhooks/plaid                Signature-verified Plaid webhooks
 *
 * POST   /api/link/session              -> {url, expiresInSeconds}
 * GET    /api/connections               DELETE /api/connections/:id
 * GET    /api/accounts                  Live balances
 * POST   /api/sync                      GET /api/transactions?limit=
 * PUT    /api/broker {keyId,secret,paper}   DELETE /api/broker
 * GET    /api/portfolio?account=paper|broker
 * GET    /api/policy                    PUT /api/policy
 * POST   /api/kill-switch {on}
 * POST   /api/orders {account, orders:[{symbol,side,notionalUsd}], note}
 * GET    /api/approvals?status=         POST /api/approvals/:id/approve|decline
 * GET    /api/agents                    PATCH /api/agents/:id   POST /api/agents/:id/run
 * GET    /api/ledger?limit=             GET /api/ledger/verify
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Authenticate, Principal } from "./auth.ts";
import { MetatronError, type MetatronService } from "./service.ts";
import { PlaidError } from "./plaid.ts";
import { BrokerError } from "./broker.ts";
import type { Origin } from "./guardrails.ts";

export interface AppOptions {
  service: MetatronService;
  authenticate: Authenticate;
  /** Browser origins allowed to call the API (the METATRON app, Spectre, etc.). */
  allowedOrigins: string[];
  /** Public base URL of this server, used to build the Link page URL. */
  publicOrigin: string;
  /** Approving trades needs a sign-in no older than this. */
  approvalMaxSessionAgeMinutes?: number;
  publicDir?: string;
  clock?: () => Date;
}

class HttpError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.body = { error: message, ...extra };
  }
}

const MAX_BODY = 64 * 1024;
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, "Request too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(body: string): Record<string, any> {
  if (!body) return {};
  try {
    const v = JSON.parse(body);
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  } catch { /* fall through */ }
  throw new HttpError(400, "Body must be a JSON object");
}

export function createApp(opts: AppOptions) {
  const svc = opts.service;
  const maxAgeMs = (opts.approvalMaxSessionAgeMinutes ?? 60) * 60_000;
  const now = () => opts.clock?.() ?? new Date();
  const hits = new Map<string, { n: number; reset: number }>();

  const limited = (key: string, max = 120) => {
    const t = Date.now(), h = hits.get(key);
    if (!h || h.reset < t) { hits.set(key, { n: 1, reset: t + 60_000 }); return false; }
    return ++h.n > max;
  };

  async function principal(req: IncomingMessage, need: "read" | "trade"): Promise<Principal> {
    const m = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""));
    if (!m) throw new HttpError(401, "Sign in with Cumulus://ID");
    const p = await opts.authenticate(m[1]);
    if (!p) throw new HttpError(401, "Your session has expired. Sign in again.");
    if (!p.canRead) throw new HttpError(403, "METATRON's access was turned off in your Cumulus://ID permissions");
    if (need === "trade" && !p.canTrade) throw new HttpError(403, "Allow METATRON to trade in your Cumulus://ID permissions first");
    if (limited(p.cid)) throw new HttpError(429, "Too many requests. Slow down a little.");
    return p;
  }

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
  };

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://local");
    const path = url.pathname, method = req.method ?? "GET";
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    const origin = String(req.headers.origin ?? "");
    if (origin && opts.allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Metatron-Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    }
    if (method === "OPTIONS") { res.statusCode = 204; res.end(); return; }

    try {
      if (method === "GET" && path === "/health") return send(res, 200, { ok: true, service: "metatron", time: now().toISOString() });

      if (method === "GET" && path === "/link") {
        const html = await readFile(join(opts.publicDir ?? join(import.meta.dirname, "..", "public"), "link.html"), "utf8");
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.plaid.com; frame-src https://cdn.plaid.com; connect-src 'self' https://*.plaid.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:");
        res.end(html);
        return;
      }

      if (method === "POST" && path === "/link/token") {
        if (limited("ip:" + req.socket.remoteAddress, 30)) throw new HttpError(429, "Too many requests");
        const b = json(await readBody(req));
        return send(res, 200, await svc.linkToken(String(b.code ?? ""), { investments: !!b.investments }));
      }
      if (method === "POST" && path === "/link/exchange") {
        if (limited("ip:" + req.socket.remoteAddress, 30)) throw new HttpError(429, "Too many requests");
        const b = json(await readBody(req));
        return send(res, 200, await svc.exchange(String(b.code ?? ""), String(b.publicToken ?? ""), String(b.institution ?? "")));
      }
      if (method === "POST" && path === "/webhooks/plaid") {
        const raw = await readBody(req);
        const ok = await svc.webhook(raw, req.headers["plaid-verification"] as string | undefined);
        return send(res, ok ? 200 : 401, ok ? { ok: true } : { error: "Invalid webhook signature" });
      }

      if (!path.startsWith("/api/")) throw new HttpError(404, "Not found");
      const mutating = method !== "GET";
      const needTrade = /^\/api\/(orders|approvals\/[^/]+\/approve|agents\/[^/]+\/run|broker)/.test(path) && mutating;
      const p = await principal(req, needTrade ? "trade" : "read");
      const body = mutating ? json(await readBody(req)) : {};
      let m: RegExpExecArray | null;

      if (method === "POST" && path === "/api/link/session") {
        const c = svc.createLinkCode(p.cid);
        return send(res, 200, { url: `${opts.publicOrigin}/link#code=${c.code}`, expiresInSeconds: c.expiresInSeconds });
      }
      if (method === "GET" && path === "/api/connections") return send(res, 200, await svc.connections(p.cid));
      if (method === "DELETE" && (m = /^\/api\/connections\/([\w-]+)$/.exec(path))) return send(res, 200, await svc.removeConnection(p.cid, m[1]));
      if (method === "GET" && path === "/api/accounts") return send(res, 200, await svc.accounts(p.cid));
      if (method === "POST" && path === "/api/sync") return send(res, 200, await svc.sync(p.cid, body.connectionId ? String(body.connectionId) : undefined));
      if (method === "GET" && path === "/api/transactions") return send(res, 200, await svc.transactions(p.cid, Number(url.searchParams.get("limit") ?? 200)));

      if (method === "PUT" && path === "/api/broker") return send(res, 200, await svc.connectBroker(p.cid, { keyId: String(body.keyId ?? ""), secret: String(body.secret ?? ""), paper: body.paper !== false }));
      if (method === "DELETE" && path === "/api/broker") return send(res, 200, await svc.disconnectBroker(p.cid));
      if (method === "GET" && path === "/api/portfolio") return send(res, 200, await svc.portfolio(p.cid, url.searchParams.get("account") === "broker" ? "broker" : "paper"));

      if (method === "GET" && path === "/api/policy") return send(res, 200, await svc.policy(p.cid));
      if (method === "PUT" && path === "/api/policy") return send(res, 200, await svc.setPolicy(p.cid, body));
      if (method === "POST" && path === "/api/kill-switch") return send(res, 200, await svc.setPolicy(p.cid, { killSwitch: !!body.on }));

      if (method === "POST" && path === "/api/orders") {
        // The assistant labels its requests so automated-order rules apply; a client can only make its own rules stricter.
        const origin: Origin = req.headers["x-metatron-origin"] === "assistant" ? "assistant" : "user";
        return send(res, 201, await svc.propose(p.cid, { account: body.account === "broker" ? "broker" : "paper", orders: body.orders, origin, note: body.note }));
      }
      if (method === "GET" && path === "/api/approvals") {
        const st = url.searchParams.get("status") as any;
        return send(res, 200, await svc.approvals(p.cid, st || undefined));
      }
      if (method === "POST" && (m = /^\/api\/approvals\/([\w-]+)\/(approve|decline)$/.exec(path))) {
        if (m[2] === "approve" && now().getTime() - new Date(p.sessionStartedAt).getTime() > maxAgeMs) {
          throw new HttpError(401, "For your safety, sign in again before approving.", { code: "reauth_required" });
        }
        return send(res, 200, await svc.decide(p.cid, m[1], m[2] as "approve" | "decline"));
      }

      if (method === "GET" && path === "/api/agents") return send(res, 200, await svc.agents(p.cid));
      if (method === "PATCH" && (m = /^\/api\/agents\/([\w-]+)$/.exec(path))) return send(res, 200, await svc.updateAgent(p.cid, m[1], body));
      if (method === "POST" && (m = /^\/api\/agents\/([\w-]+)\/run$/.exec(path))) return send(res, 200, await svc.runAgent(p.cid, m[1]));

      if (method === "GET" && path === "/api/ledger") return send(res, 200, await svc.ledgerFor(p.cid, Number(url.searchParams.get("limit") ?? 100)));
      if (method === "GET" && path === "/api/ledger/verify") return send(res, 200, await svc.verifyLedger());

      throw new HttpError(404, "Not found");
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, err.body);
      if (err instanceof MetatronError) return send(res, err.status, { error: err.message, ...(err.reasons ? { reasons: err.reasons } : {}) });
      if (err instanceof PlaidError) return send(res, err.status >= 500 ? 502 : 400, { error: err.message, code: err.code });
      if (err instanceof BrokerError) return send(res, err.status >= 500 ? 502 : 400, { error: err.message });
      console.error("[metatron]", (err as Error).message);
      return send(res, 500, { error: "Something went wrong. Try again." });
    }
  };
}

/* ------------------------------------------------------------------ *
 * Standalone server (node src/server.ts)
 * ------------------------------------------------------------------ */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { buildFromEnv } = await import("./env.ts");
  const app = await buildFromEnv(process.env);
  const port = Number(process.env.PORT ?? 3005);
  createServer(createApp(app)).listen(port, () => console.log(`METATRON listening on :${port} (Plaid: ${app.plaidStatus})`));
}
