/**
 * HTTP surface for CNDCTR: public health, Cumulus ID sign-in, and /api/perform.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { perform, planScore, recordEvidence, type Autonomy } from "@infinitum/architect/perform";
import { Ledger } from "@infinitum/firmament";
import { CndctrAuthError, isPublicSigningKey, verifyCndctrToken, type CndctrIdentity, type Jwk } from "./auth.ts";
import type { CndctrConfig } from "./config.ts";
import { SessionStore } from "./sessions.ts";

export interface Deps {
  config: CndctrConfig;
  origin: () => string;
  ledger: Ledger;
  publicDir: string;
  sessions?: SessionStore;
}

const AUTONOMY: readonly Autonomy[] = ["rehearsal", "accompaniment", "autopilot"];

const SECURITY = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "content-security-policy": "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'",
  "cache-control": "no-store",
};

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function createHandler(deps: Deps): (req: IncomingMessage, res: ServerResponse) => void {
  const assets = loadAssets(deps.publicDir);
  const sessions = deps.sessions ?? new SessionStore();
  const jwks = new JwksCache(deps.config.jwksUri);
  const limiter = new Limiter();

  return (req, res) => {
    void dispatch(req, res, deps, assets, sessions, jwks, limiter).catch((error: unknown) => fail(res, error));
  };
}

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  deps: Deps,
  assets: Map<string, { type: string; body: Buffer }>,
  sessions: SessionStore,
  jwks: JwksCache,
  limiter: Limiter,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://cndctr.local");
  const path = url.pathname;

  if (method === "GET" && path === "/health") return health(res);
  if (method === "GET" && path === "/api/config") {
    return sendJson(res, 200, {
      product: "CNDCTR",
      service: "cndctr",
      publisher: "Infinitum Corporation®",
      issuer: deps.config.issuer,
      audience: deps.config.audience,
      login: "/api/auth/login",
      perform: "/api/perform",
    });
  }
  if (method === "GET" && path === "/api/auth/login") {
    if (!limiter.allow(`login:${remote(req)}`, 30, 60_000)) throw new HttpError(429, "too many requests");
    return startLogin(res, deps, sessions, url);
  }
  if (method === "GET" && path === "/api/auth/callback") return finishLogin(url, res, deps, sessions, jwks);
  if (method === "POST" && path === "/api/auth/logout") return logout(req, res, deps, sessions);
  if (method === "GET" && path === "/api/me") {
    const actor = await authenticate(req, deps, sessions, jwks);
    return sendJson(res, 200, publicIdentity(actor.identity));
  }
  if (method === "GET" && path === "/api/status") {
    await authenticate(req, deps, sessions, jwks);
    const entries = await deps.ledger.entries();
    return sendJson(res, 200, { service: "cndctr", ledgerEntries: entries.length, autonomyLevels: AUTONOMY });
  }
  if (path === "/api/perform") {
    if (method !== "POST") throw new HttpError(405, "method not allowed");
    const actor = await authenticate(req, deps, sessions, jwks);
    if (!actor.bearer) assertOrigin(req, deps);
    if (!limiter.allow(`perform:${actor.identity.sub}`, 60, 60_000)) throw new HttpError(429, "too many requests");
    const planned = parsePerform(await readJson(req));
    const score = planScore(planned.intent, planned.autonomy);
    const performance = await perform(score, new Set(["web:read"]), planned.allowed);
    const evidence = await recordEvidence(deps.ledger, performance, `cid:${actor.identity.sub}`);
    return sendJson(res, 200, { score, performance, evidenceHash: evidence.hash });
  }
  if (method === "GET" && assets.has(path)) {
    const asset = assets.get(path)!;
    res.writeHead(200, { ...SECURITY, "content-type": asset.type, "content-length": asset.body.length });
    res.end(asset.body);
    return;
  }
  sendJson(res, 404, { error: "not found" });
}

function health(res: ServerResponse): void {
  sendJson(res, 200, { ok: true, service: "cndctr", product: "CNDCTR" });
}

function startLogin(res: ServerResponse, deps: Deps, sessions: SessionStore, url: URL): void {
  const origin = deps.origin();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  sessions.saveState(state, verifier, nonce, Date.now() + 10 * 60 * 1000);
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
  // "Create a Cumulus://ID" in the account bar opens account creation at the issuer.
  const prompt = url.searchParams.get("prompt");
  if (prompt === "create" || prompt === "login") auth.searchParams.set("prompt", prompt);
  res.writeHead(302, { ...SECURITY, location: auth.href });
  res.end();
}

async function finishLogin(url: URL, res: ServerResponse, deps: Deps, sessions: SessionStore, jwks: JwksCache): Promise<void> {
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
    const saved = sessions.takeState(state);
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
    const text = await tokenRes.text();
    if (text.length > 32_000) return failLogin("token body");
    const payload = JSON.parse(text) as { id_token?: unknown };
    if (typeof payload.id_token !== "string") return failLogin("id_token");
    const identity = verifyCndctrToken(payload.id_token, {
      issuer: deps.config.issuer,
      audience: deps.config.audience,
      jwks: await jwks.get(),
      clockSkewSeconds: deps.config.clockSkewSeconds,
      nonce: saved.nonce,
    });
    const token = randomBytes(32).toString("base64url");
    const maxAge = Math.min(identity.expiresAt - Math.floor(Date.now() / 1000), 12 * 60 * 60);
    if (maxAge < 1) return failLogin("expired");
    sessions.create(token, identity, Date.now() + maxAge * 1000);
    res.writeHead(302, { ...SECURITY, location: `${origin}/`, "set-cookie": sessionCookie(origin, token, maxAge) });
    res.end();
  } catch (error) {
    const reason = error instanceof CndctrAuthError ? error.code : "rejected";
    return failLogin(reason);
  }
}

function logout(req: IncomingMessage, res: ServerResponse, deps: Deps, sessions: SessionStore): void {
  const origin = deps.origin();
  const cookie = readCookie(headerValue(req.headers.cookie), "cndctr_session");
  if (cookie) {
    assertOrigin(req, deps);
    sessions.delete(cookie);
  }
  res.writeHead(204, { ...SECURITY, "set-cookie": sessionCookie(origin, "", 0) });
  res.end();
}

interface Actor {
  identity: CndctrIdentity;
  bearer: boolean;
}

async function authenticate(req: IncomingMessage, deps: Deps, sessions: SessionStore, jwks: JwksCache): Promise<Actor> {
  const authorization = headerValue(req.headers.authorization);
  if (authorization.startsWith("Bearer ")) {
    const token = authorization.slice(7).trim();
    try {
      let identity: CndctrIdentity;
      try {
        identity = verifyCndctrToken(token, {
          issuer: deps.config.issuer,
          audience: deps.config.audience,
          jwks: await jwks.get(),
          clockSkewSeconds: deps.config.clockSkewSeconds,
        });
      } catch (error) {
        if (!(error instanceof CndctrAuthError) || error.code !== "key") throw error;
        identity = verifyCndctrToken(token, {
          issuer: deps.config.issuer,
          audience: deps.config.audience,
          jwks: await jwks.get(true),
          clockSkewSeconds: deps.config.clockSkewSeconds,
        });
      }
      return { identity, bearer: true };
    } catch (error) {
      if (error instanceof CndctrAuthError) console.warn(`auth rejected: ${error.code}`);
      throw new HttpError(401, "unauthorized");
    }
  }
  const cookie = readCookie(headerValue(req.headers.cookie), "cndctr_session");
  if (!cookie) throw new HttpError(401, "unauthorized");
  const identity = sessions.read(cookie);
  if (!identity || identity.issuer !== deps.config.issuer) throw new HttpError(401, "unauthorized");
  return { identity, bearer: false };
}

function parsePerform(body: unknown): { intent: string; autonomy: Autonomy; allowed: Set<Autonomy> } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "bad request");
  const record = body as Record<string, unknown>;
  if (typeof record.intent !== "string" || record.intent.includes("\u0000")) throw new HttpError(400, "intent is required");
  const intent = record.intent.trim();
  if (!intent || intent.length > 16_000) throw new HttpError(400, "intent is required");
  const autonomy = record.autonomy === undefined ? "rehearsal" : parseAutonomy(record.autonomy);
  if (!autonomy) throw new HttpError(400, "autonomy is invalid");
  return { intent, autonomy, allowed: parseAllowed(record.allowedAutonomy) };
}

function parseAutonomy(value: unknown): Autonomy | null {
  return typeof value === "string" && (AUTONOMY as readonly string[]).includes(value) ? value as Autonomy : null;
}

function parseAllowed(value: unknown): Set<Autonomy> {
  if (value === undefined) return new Set(AUTONOMY);
  if (!Array.isArray(value) || value.length === 0 || value.length > AUTONOMY.length) throw new HttpError(400, "autonomy is invalid");
  const allowed = new Set<Autonomy>();
  for (const item of value) {
    const autonomy = parseAutonomy(item);
    if (!autonomy) throw new HttpError(400, "autonomy is invalid");
    allowed.add(autonomy);
  }
  return allowed;
}

function publicIdentity(identity: CndctrIdentity): { sub: string; username: string; email: string | null; name: string | null } {
  return { sub: identity.sub, username: identity.username, email: identity.email, name: identity.name };
}

function assertOrigin(req: IncomingMessage, deps: Deps): void {
  if (headerValue(req.headers.origin) !== deps.origin()) throw new HttpError(403, "origin rejected");
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const type = headerValue(req.headers["content-type"]);
  if (!type.toLowerCase().startsWith("application/json")) throw new HttpError(415, "unsupported content type");
  const text = await readBody(req, 32_768);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "bad request");
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const declared = headerValue(req.headers["content-length"]);
  if (declared && Number(declared) > limit) {
    req.resume();
    return Promise.reject(new HttpError(413, "payload too large"));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, "payload too large"));
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
  if (error instanceof HttpError) {
    sendJson(res, error.status, { error: error.message });
    return;
  }
  if (error instanceof CndctrAuthError) {
    console.warn(`auth rejected: ${error.code}`);
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }
  console.error(error instanceof Error ? error.message : "request failed");
  sendJson(res, 500, { error: "unavailable" });
}

function sessionCookie(origin: string, token: string, maxAge: number): string {
  const secure = origin.startsWith("https:") ? "; Secure" : "";
  return `cndctr_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

function readCookie(header: string, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function remote(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

function loadAssets(dir: string): Map<string, { type: string; body: Buffer }> {
  const spec: Record<string, [string, string]> = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/app.css": ["app.css", "text/css; charset=utf-8"],
    "/cumulus-bar.js": ["cumulus-bar.js", "text/javascript; charset=utf-8"],
  };
  const assets = new Map<string, { type: string; body: Buffer }>();
  for (const [path, [file, type]] of Object.entries(spec)) {
    assets.set(path, { type, body: readFileSync(join(dir, file)) });
  }
  return assets;
}

class JwksCache {
  private readonly uri: string;
  private keys: Jwk[] = [];
  private fetchedAt = 0;

  constructor(uri: string) {
    this.uri = uri;
  }

  async get(force = false): Promise<Jwk[]> {
    if (!force && this.keys.length > 0 && Date.now() - this.fetchedAt < 300_000) return this.keys;
    const res = await fetch(this.uri, { redirect: "error", signal: AbortSignal.timeout(5_000), headers: { accept: "application/json" } });
    if (!res.ok) throw new CndctrAuthError("jwks");
    const text = await res.text();
    if (text.length > 100_000) throw new CndctrAuthError("jwks");
    let body: { keys?: unknown };
    try {
      body = JSON.parse(text) as { keys?: unknown };
    } catch {
      throw new CndctrAuthError("jwks");
    }
    const keys = Array.isArray(body.keys) ? body.keys.filter(isPublicSigningKey) : [];
    if (keys.length === 0) throw new CndctrAuthError("jwks");
    this.keys = keys;
    this.fetchedAt = Date.now();
    return keys;
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
