/**
 * HTTP surface for FABRIC++: health, metrics, Cumulus ID sign-in, and messaging.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { isPublicSigningKey, verifyFabricToken, FabricAuthError, type FabricIdentity } from "./auth.ts";
import type { FabricConfig } from "./config.ts";
import { FabricService, FabricServiceError, touchUser } from "./service.ts";
import type { FabricStore } from "./store.ts";

interface Deps {
  config: FabricConfig;
  origin: () => string;
  store: FabricStore;
  service: FabricService;
  publicDir: string;
}

const SECURITY = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "content-security-policy": "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; connect-src 'self' https://api2.amplitude.com https://api.amplitude.com",
  "cache-control": "no-store",
};

export function createHandler(deps: Deps): (req: IncomingMessage, res: ServerResponse) => void {
  const assets = loadAssets(deps.publicDir);
  const jwks = new JwksCache(deps.config.jwksUri);
  const metrics = new Metrics();
  const limiter = new Limiter();

  return (req, res) => {
    const started = Date.now();
    void dispatch(req, res, deps, assets, jwks, metrics, limiter)
      .catch((error: unknown) => fail(res, error))
      .finally(() => {
        metrics.observe(req.method ?? "GET", res.statusCode || 500, Date.now() - started);
      });
  };
}

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  deps: Deps,
  assets: Map<string, { type: string; body: Buffer }>,
  jwks: JwksCache,
  metrics: Metrics,
  limiter: Limiter,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://fabric.local");
  const path = url.pathname;

  if (method === "GET" && (path === "/health" || path === "/healthz")) {
    return health(res, deps);
  }
  if (method === "GET" && path === "/metrics") {
    return metricsResponse(req, res, deps, metrics);
  }
  if (method === "GET" && path === "/api/config") {
    const origin = deps.origin();
    return sendJson(res, 200, {
      product: "FABRIC++",
      rootDomain: deps.config.rootDomain,
      issuer: deps.config.issuer,
      clientId: deps.config.audience,
      login: "/api/auth/login",
      origin,
    });
  }
  if (method === "GET" && path === "/api/auth/login") {
    if (!limiter.allow(`login:${remote(req)}`, 30, 60_000)) throw new FabricServiceError(429, "too many requests");
    return startLogin(req, res, deps, url);
  }
  if (method === "GET" && path === "/api/auth/callback") return finishLogin(url, res, deps, jwks);
  if (method === "POST" && path === "/api/auth/logout") {
    const actor = await authenticate(req, deps, jwks, false);
    assertCookieOrigin(req, deps);
    if (actor.sessionHash) deps.store.deleteLogin(actor.sessionHash);
    res.writeHead(204, { ...SECURITY, "set-cookie": sessionCookie(deps.origin(), "", 0) });
    res.end();
    return;
  }
  if (method === "GET" && path === "/api/me") {
    const actor = await authenticate(req, deps, jwks, true);
    return sendJson(res, 200, publicIdentity(actor.identity));
  }
  if (path === "/api/sessions" && method === "GET") {
    const actor = await authenticate(req, deps, jwks, true);
    return sendJson(res, 200, { sessions: deps.service.listSessions(actor.identity) });
  }
  if (path === "/api/sessions" && method === "POST") {
    const actor = await authenticate(req, deps, jwks, true);
    assertMutation(req, deps, actor);
    if (!limiter.allow(`open:${actor.identity.sub}`, 60, 60_000)) throw new FabricServiceError(429, "too many requests");
    const body = await readJson(req);
    const username = field(body, "username");
    return sendJson(res, 201, deps.service.openSession(actor.identity, username));
  }
  const one = /^\/api\/sessions\/([0-9a-f-]{36})$/i.exec(path);
  if (one && method === "GET") {
    const actor = await authenticate(req, deps, jwks, true);
    return sendJson(res, 200, deps.service.getSession(actor.identity, one[1] ?? ""));
  }
  const messages = /^\/api\/sessions\/([0-9a-f-]{36})\/messages$/i.exec(path);
  if (messages && method === "GET") {
    const actor = await authenticate(req, deps, jwks, true);
    return sendJson(res, 200, { messages: deps.service.receive(actor.identity, messages[1] ?? "") });
  }
  if (messages && method === "POST") {
    const actor = await authenticate(req, deps, jwks, true);
    assertMutation(req, deps, actor);
    if (!limiter.allow(`send:${actor.identity.sub}`, 120, 60_000)) throw new FabricServiceError(429, "too many requests");
    const body = await readJson(req);
    const text = field(body, "text");
    return sendJson(res, 201, deps.service.send(actor.identity, messages[1] ?? "", text));
  }
  if (method === "GET" && assets.has(path)) {
    const asset = assets.get(path)!;
    res.writeHead(200, { ...SECURITY, "content-type": asset.type, "content-length": asset.body.length });
    res.end(asset.body);
    return;
  }
  sendJson(res, 404, { error: "not found" });
}

function health(res: ServerResponse, deps: Deps): void {
  try {
    deps.store.ping();
  } catch {
    sendJson(res, 503, { status: "unavailable", service: "fabric" });
    return;
  }
  sendJson(res, 200, {
    status: "ok",
    service: "fabric",
    rootDomain: deps.config.rootDomain,
    issuer: deps.config.issuer,
  });
}

function metricsResponse(req: IncomingMessage, res: ServerResponse, deps: Deps, metrics: Metrics): void {
  const expected = deps.config.metricsToken;
  if (expected) {
    const header = req.headers.authorization ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!safeEqual(presented, expected)) throw new FabricServiceError(401, "unauthorized");
  }
  const counts = deps.store.counts();
  const body = metrics.render(counts);
  res.writeHead(200, { ...SECURITY, "content-type": "text/plain; version=0.0.4; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function startLogin(req: IncomingMessage, res: ServerResponse, deps: Deps, url: URL): void {
  const origin = deps.origin();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const now = new Date();
  const expires = new Date(now.getTime() + 10 * 60 * 1000);
  deps.store.saveOauthState(state, verifier, nonce, expires.toISOString(), now.toISOString());
  const auth = new URL(deps.config.authorizationEndpoint);
  auth.searchParams.set("client_id", deps.config.audience);
  auth.searchParams.set("redirect_uri", `${origin}/api/auth/callback`);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("scope", "openid profile email");
  auth.searchParams.set("state", state);
  auth.searchParams.set("nonce", nonce);
  auth.searchParams.set("code_challenge", challenge);
  auth.searchParams.set("code_challenge_method", "S256");
  const hint = url.searchParams.get("login_hint");
  if (hint && /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/i.test(hint)) auth.searchParams.set("login_hint", hint.toLowerCase());
  res.writeHead(302, { ...SECURITY, location: auth.href });
  res.end();
  void req;
}

async function finishLogin(url: URL, res: ServerResponse, deps: Deps, jwks: JwksCache): Promise<void> {
  const origin = deps.origin();
  const failLogin = (reason: string): void => {
    console.warn(`sign-in failed: ${reason}`);
    res.writeHead(302, { ...SECURITY, location: `${origin}/?error=sign-in-failed` });
    res.end();
  };
  try {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state || code.length > 512 || state.length > 128) return failLogin("missing code");
    const saved = deps.store.takeOauthState(state, new Date().toISOString());
    if (!saved) return failLogin("state");
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${origin}/api/auth/callback`,
      client_id: deps.config.audience,
      code_verifier: saved.verifier,
    });
    if (deps.config.clientSecret) body.set("client_secret", deps.config.clientSecret);
    const tokenRes = await fetch(deps.config.tokenEndpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
    });
    if (!tokenRes.ok) return failLogin(`token status ${tokenRes.status}`);
    const payload = await tokenRes.json() as { id_token?: unknown };
    if (typeof payload.id_token !== "string") return failLogin("id_token");
    const keys = await jwks.get();
    const identity = verifyFabricToken(payload.id_token, {
      issuer: deps.config.issuer,
      audience: deps.config.audience,
      jwks: keys,
      clockSkewSeconds: deps.config.clockSkewSeconds,
      nonce: saved.nonce,
    });
    remember(deps, identity);
    const token = randomBytes(32).toString("base64url");
    const maxAge = Math.min(identity.expiresAt - Math.floor(Date.now() / 1000), 12 * 60 * 60);
    if (maxAge < 1) return failLogin("expired");
    deps.store.createLogin({ tokenHash: hashToken(token), sub: identity.sub, expiresAt: new Date(identity.expiresAt * 1000).toISOString() });
    res.writeHead(302, { ...SECURITY, location: `${origin}/`, "set-cookie": sessionCookie(origin, token, maxAge) });
    res.end();
  } catch (error) {
    const reason = error instanceof FabricAuthError ? error.code : "rejected";
    return failLogin(reason);
  }
}

interface Actor {
  identity: FabricIdentity;
  bearer: boolean;
  sessionHash: string | null;
}

async function authenticate(req: IncomingMessage, deps: Deps, jwks: JwksCache, required: boolean): Promise<Actor> {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    const token = header.slice(7).trim();
    try {
      const keys = await jwks.get();
      let identity: FabricIdentity;
      try {
        identity = verifyFabricToken(token, { issuer: deps.config.issuer, audience: deps.config.audience, jwks: keys, clockSkewSeconds: deps.config.clockSkewSeconds });
      } catch (error) {
        if (!(error instanceof FabricAuthError) || error.code !== "key") throw error;
        identity = verifyFabricToken(token, { issuer: deps.config.issuer, audience: deps.config.audience, jwks: await jwks.get(true), clockSkewSeconds: deps.config.clockSkewSeconds });
      }
      remember(deps, identity);
      return { identity, bearer: true, sessionHash: null };
    } catch (error) {
      if (error instanceof FabricAuthError) console.warn(`auth rejected: ${error.code}`);
      throw new FabricServiceError(401, "unauthorized");
    }
  }
  const cookie = readCookie(req.headers.cookie, "fabric_session");
  if (!cookie) throw new FabricServiceError(401, "unauthorized");
  const sessionHash = hashToken(cookie);
  const row = deps.store.getLogin(sessionHash);
  if (!row || row.expiresAt <= new Date().toISOString()) {
    if (row) deps.store.deleteLogin(sessionHash);
    throw new FabricServiceError(401, "unauthorized");
  }
  const user = deps.store.findUserBySub(row.sub);
  if (!user || user.issuer !== deps.config.issuer) throw new FabricServiceError(401, "unauthorized");
  if (!required) {
    // caller still receives the actor
  }
  return {
    identity: { sub: user.sub, issuer: user.issuer, username: user.username, email: user.email, name: user.name, expiresAt: Math.floor(Date.parse(row.expiresAt) / 1000) },
    bearer: false,
    sessionHash,
  };
}

function remember(deps: Deps, identity: FabricIdentity): void {
  try {
    touchUser(deps.store, identity);
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) throw new FabricServiceError(409, "username is already in use");
    throw error;
  }
}

function assertMutation(req: IncomingMessage, deps: Deps, actor: Actor): void {
  if (actor.bearer) return;
  assertCookieOrigin(req, deps);
}

function assertCookieOrigin(req: IncomingMessage, deps: Deps): void {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || origin !== deps.origin()) throw new FabricServiceError(403, "origin rejected");
}

function publicIdentity(identity: FabricIdentity): { sub: string; username: string; email: string | null; name: string | null } {
  return { sub: identity.sub, username: identity.username, email: identity.email, name: identity.name };
}

function field(body: unknown, key: string): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new FabricServiceError(400, "bad request");
  const value = (body as Record<string, unknown>)[key];
  if (typeof value !== "string") throw new FabricServiceError(400, key === "text" ? "text is required" : "username is invalid");
  return value;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const type = req.headers["content-type"];
  if (typeof type !== "string" || !type.toLowerCase().startsWith("application/json")) throw new FabricServiceError(415, "unsupported content type");
  const text = await readBody(req, 16_384);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new FabricServiceError(400, "bad request");
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const declared = req.headers["content-length"];
  if (typeof declared === "string" && Number(declared) > limit) {
    req.resume();
    return Promise.reject(new FabricServiceError(413, "payload too large"));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new FabricServiceError(413, "payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...SECURITY, "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function fail(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (error instanceof FabricServiceError) {
    sendJson(res, error.status, { error: error.message });
    return;
  }
  if (error instanceof FabricAuthError) {
    console.warn(`auth rejected: ${error.code}`);
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }
  console.error(error instanceof Error ? error.message : "request failed");
  sendJson(res, 500, { error: "unavailable" });
}

function sessionCookie(origin: string, token: string, maxAge: number): string {
  const secure = origin.startsWith("https:") ? "; Secure" : "";
  return `fabric_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function safeEqual(presented: string, expected: string): boolean {
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function remote(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

function loadAssets(dir: string): Map<string, { type: string; body: Buffer }> {
  const spec: Record<string, [string, string]> = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/app-shell.css": ["app-shell.css", "text/css; charset=utf-8"],
    "/app.css": ["app.css", "text/css; charset=utf-8"],
    "/firm-suite.js": ["firm-suite.js", "text/javascript; charset=utf-8"],
    "/firm-suite.css": ["firm-suite.css", "text/css; charset=utf-8"],
  };
  const assets = new Map<string, { type: string; body: Buffer }>();
  for (const [path, [file, type]] of Object.entries(spec)) {
    assets.set(path, { type, body: readFileSync(join(dir, file)) });
  }
  return assets;
}

class JwksCache {
  private readonly uri: string;
  private keys: ReturnType<typeof asKeys> = [];
  private fetchedAt = 0;

  constructor(uri: string) {
    this.uri = uri;
  }

  async get(force = false) {
    if (!force && this.keys.length > 0 && Date.now() - this.fetchedAt < 300_000) return this.keys;
    const res = await fetch(this.uri, { redirect: "error", signal: AbortSignal.timeout(5_000), headers: { accept: "application/json" } });
    if (!res.ok) throw new FabricAuthError("jwks");
    const text = await res.text();
    if (text.length > 100_000) throw new FabricAuthError("jwks");
    let body: { keys?: unknown };
    try {
      body = JSON.parse(text) as { keys?: unknown };
    } catch {
      throw new FabricAuthError("jwks");
    }
    const keys = asKeys(body.keys);
    if (keys.length === 0) throw new FabricAuthError("jwks");
    this.keys = keys;
    this.fetchedAt = Date.now();
    return keys;
  }
}

function asKeys(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter(isPublicSigningKey);
}

class Metrics {
  private readonly hits = new Map<string, number>();

  observe(method: string, status: number, _ms: number): void {
    const verb = /^(GET|POST|PUT|DELETE|HEAD|OPTIONS)$/.test(method) ? method : "OTHER";
    const code = Number.isInteger(status) && status >= 100 && status <= 599 ? String(status) : "0";
    const key = `${verb} ${code}`;
    this.hits.set(key, (this.hits.get(key) ?? 0) + 1);
  }

  render(counts: { users: number; sessions: number; messages: number }): string {
    const lines = [
      "# HELP fabric_up 1 when the process is serving.",
      "# TYPE fabric_up gauge",
      "fabric_up 1",
      "# HELP fabric_users Accounts that have signed in.",
      "# TYPE fabric_users gauge",
      `fabric_users ${counts.users}`,
      "# HELP fabric_sessions Messaging sessions.",
      "# TYPE fabric_sessions gauge",
      `fabric_sessions ${counts.sessions}`,
      "# HELP fabric_messages Stored encrypted messages.",
      "# TYPE fabric_messages gauge",
      `fabric_messages ${counts.messages}`,
      "# HELP fabric_http_requests_total HTTP responses by method and status.",
      "# TYPE fabric_http_requests_total counter",
    ];
    for (const [key, count] of this.hits) {
      const [method, status] = key.split(" ");
      lines.push(`fabric_http_requests_total{method="${method}",status="${status}"} ${count}`);
    }
    return `${lines.join("\n")}\n`;
  }
}

class Limiter {
  private readonly buckets = new Map<string, { n: number; reset: number }>();

  allow(key: string, max: number, windowMs: number): boolean {
    const now = Date.now();
    if (this.buckets.size > 10_000) this.buckets.clear();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.reset < now) {
      this.buckets.set(key, { n: 1, reset: now + windowMs });
      return true;
    }
    bucket.n += 1;
    return bucket.n <= max;
  }
}
