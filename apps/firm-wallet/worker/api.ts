/**
 * The wallet's small server side. It never sees keys, phrases or balances: it serves the app and,
 * forwards Derive's public option data and Kalshi's public market data (both block direct
 * browser calls; only read-only, allow-listed paths are forwarded), and, only if
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

/** Kalshi's public market data (no account needed). Browsers can't call it directly (no CORS). */
const KALSHI_UPSTREAM = "https://api.elections.kalshi.com/trade-api/v2";
const KALSHI_ID = "[A-Za-z0-9._-]{1,80}";
const KALSHI_PATHS = [
  /^events$/,
  /^markets$/,
  new RegExp(`^events/${KALSHI_ID}$`),
  new RegExp(`^markets/${KALSHI_ID}/orderbook$`),
  new RegExp(`^series/${KALSHI_ID}/markets/${KALSHI_ID}/candlesticks$`),
];
/** Kalshi asks API clients to identify themselves. */
const CLIENT_NAME = "InfinitumFirmWallet/1.0 (+https://infinitumcorporation.ai)";

const KALSHI_MARKET_FIELDS = ["ticker", "title", "yes_sub_title", "status", "close_time", "yes_bid_dollars", "yes_ask_dollars", "last_price_dollars", "previous_price_dollars", "volume_24h_fp", "volume_fp"];

/** Event lists only need prices and titles: drops rule text and other bulk (about 5× smaller). */
export function trimKalshiEvents(body: string): string {
  try {
    const d = JSON.parse(body) as { events?: { markets?: Record<string, unknown>[]; settlement_sources?: unknown }[] };
    for (const e of d.events ?? []) {
      delete e.settlement_sources;
      e.markets = (e.markets ?? []).map((m) => Object.fromEntries(KALSHI_MARKET_FIELDS.filter((k) => k in m).map((k) => [k, m[k]])));
    }
    return JSON.stringify(d);
  } catch {
    return body;
  }
}

/** Market lists: prices, titles, the event they belong to and the first line of the rules (to name games). */
export function trimKalshiMarkets(body: string): string {
  try {
    const d = JSON.parse(body) as { markets?: Record<string, unknown>[] };
    d.markets = (d.markets ?? []).map((m) => {
      const out: Record<string, unknown> = Object.fromEntries([...KALSHI_MARKET_FIELDS, "event_ticker"].filter((k) => k in m).map((k) => [k, m[k]]));
      if (typeof m.rules_primary === "string") out.rules_primary = m.rules_primary.slice(0, 200);
      return out;
    });
    return JSON.stringify(d);
  } catch {
    return body;
  }
}

async function kalshiProxy(request: Request, path: string, search: string): Promise<Response> {
  if (request.method !== "GET") return json({ error: "GET only" }, 405);
  if (!KALSHI_PATHS.some((p) => p.test(path)) || search.length > 400) return json({ error: "not found" }, 404);
  // Kalshi's event lists are slow (often 15 s+) and large, so Cloudflare's edge cache shares one
  // fetch a minute between visitors (free; ignored outside Workers).
  const upstream = await fetch(`${KALSHI_UPSTREAM}/${path}${search}`, {
    headers: { accept: "application/json", "user-agent": CLIENT_NAME },
    cf: { cacheTtl: path === "events" || path === "markets" ? 60 : 10, cacheEverything: true },
  } as RequestInit);
  let body = await upstream.text();
  if (path === "events" && upstream.ok) body = trimKalshiEvents(body);
  if (path === "markets" && upstream.ok) body = trimKalshiMarkets(body);
  return new Response(body, {
    status: upstream.status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": path === "events" || path === "markets" ? "public, max-age=30" : "public, max-age=10" },
  });
}

export async function handleApi(request: Request, env: ApiEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return null;

  if (url.pathname.startsWith("/api/kalshi/")) return kalshiProxy(request, url.pathname.slice("/api/kalshi/".length), url.search);

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

/** Telegram Web shows Mini Apps in a frame; Telegram's phone and desktop apps use a webview (no frame). */
export const TELEGRAM_FRAME_ORIGINS = ["https://web.telegram.org"];
const MINI_PATHS = new Set(["/mini", "/mini/", "/mini.html"]);

/** The mini page may be framed by Telegram Web only; every other page can't be framed at all. */
export function securityHeadersFor(pathname: string): Record<string, string> {
  if (!MINI_PATHS.has(pathname)) return SECURITY_HEADERS;
  const { "x-frame-options": _xfo, ...rest } = SECURITY_HEADERS;
  return {
    ...rest,
    "content-security-policy": SECURITY_HEADERS["content-security-policy"]!.replace("frame-ancestors 'none'", `frame-ancestors 'self' ${TELEGRAM_FRAME_ORIGINS.join(" ")}`),
  };
}
