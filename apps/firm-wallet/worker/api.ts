/**
 * The wallet's small server side. It never sees keys, phrases or balances: it serves the app and,
 * forwards Derive's public option data (Derive blocks direct browser calls), and, only if
 * configured, forwards questions to the Conjure swarm.
 * It does no region or country checks.
 * Shared by the Cloudflare Worker and the Vite dev server.
 */

export interface ApiEnv {
  /** Optional Conjure service, e.g. https://conjure.infinitumcorporation.ai */
  CONJURE_URL?: string;
  /** Conjure product key (cjp_firm-wallet_…), set as a Worker secret. */
  CONJURE_KEY?: string;
}

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });

/** Derive's v3 public API. It sends no CORS headers for other sites, so the wallet reads it through here. */
const DERIVE_UPSTREAM = {
  mainnet: "https://api.derive.xyz/v3/public",
  testnet: "https://testnet.api.derive.xyz/v3/public",
} as const;
/** Only these read-only, public market-data methods are forwarded. */
const DERIVE_METHODS = new Set(["get_all_live_instruments", "get_ticker"]);

async function deriveProxy(request: Request, mode: keyof typeof DERIVE_UPSTREAM, method: string): Promise<Response> {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  if (!DERIVE_METHODS.has(method)) return json({ error: "not found" }, 404);
  const body = await request.text();
  if (body.length > 512) return json({ error: "bad request" }, 400);
  const upstream = await fetch(`${DERIVE_UPSTREAM[mode]}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: body || "{}" });
  // Fresh headers: never pass on upstream cookies or encodings.
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": method === "get_all_live_instruments" ? "public, max-age=60" : "no-store" },
  });
}

export async function handleApi(request: Request, env: ApiEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return null;

  const derive = /^\/api\/derive\/(mainnet|testnet)\/([a-z_]{1,40})$/.exec(url.pathname);
  if (derive) return deriveProxy(request, derive[1] as keyof typeof DERIVE_UPSTREAM, derive[2]!);

  if (url.pathname.startsWith("/api/conjure")) {
    if (!env.CONJURE_URL || !env.CONJURE_KEY) return json({ error: "The Conjure swarm isn't switched on for this wallet." }, 404);
    const auth = { authorization: `Bearer ${env.CONJURE_KEY}`, "content-type": "application/json" };
    if (url.pathname === "/api/conjure" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as { question?: string; context?: string } | null;
      if (!body?.question || body.question.length > 400) return json({ error: "bad question" }, 400);
      const res = await fetch(`${env.CONJURE_URL}/v1/predictions`, {
        method: "POST", headers: auth,
        body: JSON.stringify({ question: body.question, context: String(body.context ?? "").slice(0, 2000), source: "firm-wallet", agents: 12, rounds: 3 }),
      });
      return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
    }
    const m = /^\/api\/conjure\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname);
    if (m && request.method === "GET") {
      const res = await fetch(`${env.CONJURE_URL}/v1/predictions/${m[1]}`, { headers: auth });
      return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
    }
  }
  return json({ error: "not found" }, 404);
}

/** Security headers for every page: no framing (clickjacking), scripts only from this origin. */
export const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "connect-src 'self' https:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(self), microphone=(), geolocation=(), payment=()",
  "cross-origin-opener-policy": "same-origin-allow-popups",
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
};
