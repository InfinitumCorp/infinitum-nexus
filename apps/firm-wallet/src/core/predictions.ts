/**
 * Prediction markets from Polymarket and Kalshi, in one view: trending and categorized events,
 * search, live odds, order books, price history, positions, cross-venue comparison, payout and
 * fee math, watchlists and price alerts. All from the venues' free public data.
 *
 * Trades open on the venue (Polymarket or Kalshi), which runs its own account, terms and rules.
 * The wallet does no location checks; it asks once on the device that the venue terms allow use.
 */
import {
  KALSHI_API, KALSHI_APP, POLYMARKET_APP, POLYMARKET_CLOB, POLYMARKET_DATA, POLYMARKET_GAMMA,
} from "./config.ts";

export type Venue = "polymarket" | "kalshi";

export interface Outcome {
  /** Polymarket: the outcome's CLOB token id. Kalshi: the market ticker. */
  id: string;
  label: string;
  /** Displayed chance, 0..1. */
  price: number;
  bid?: number;
  ask?: number;
  /** Change in price over the last day, in probability points (0.03 = +3 pts). */
  change24h?: number;
  volume24h?: number;
  /** Kalshi only: needed for price history. */
  series?: string;
}

export interface PredictionEvent {
  venue: Venue;
  id: string;
  title: string;
  subtitle?: string;
  category?: string;
  endDate?: string;
  volume24h: number;
  volume?: number;
  image?: string;
  rules?: string;
  url: string;
  outcomes: Outcome[];
}

export interface BookLevel { price: number; size: number }
export interface OrderBook { bids: BookLevel[]; asks: BookLevel[] }
export interface PricePoint { t: number; p: number }
export type HistoryRange = "1d" | "1w" | "1m";

export interface WatchedEvent { venue: Venue; id: string; title: string }
export interface PriceAlert {
  venue: Venue;
  eventId: string;
  outcomeId: string;
  label: string;
  eventTitle: string;
  /** Fire when the price goes above (true) or below (false) `price`. */
  above: boolean;
  price: number;
}

export interface Category { id: string; label: string; polyTag?: string; kalshi?: string[] }
export const CATEGORIES: Category[] = [
  { id: "trending", label: "Trending" },
  { id: "politics", label: "Politics", polyTag: "politics", kalshi: ["Politics", "Elections"] },
  { id: "sports", label: "Sports", polyTag: "sports", kalshi: ["Sports"] },
  { id: "crypto", label: "Crypto", polyTag: "crypto", kalshi: ["Crypto"] },
  { id: "economy", label: "Economy", polyTag: "economy", kalshi: ["Economics", "Financials", "Companies"] },
  { id: "tech", label: "Tech & science", polyTag: "tech", kalshi: ["Science and Technology"] },
  { id: "culture", label: "Culture", polyTag: "pop-culture", kalshi: ["Entertainment", "Social"] },
  { id: "world", label: "World", polyTag: "geopolitics", kalshi: ["World"] },
  { id: "climate", label: "Climate", polyTag: "weather", kalshi: ["Climate and Weather"] },
];

const num = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * The chance shown for an outcome, the way both venues do it: the middle of the bid and ask when
 * the spread is tight, otherwise the last trade.
 */
export function displayPrice(bid?: number, ask?: number, last?: number): number {
  if (bid !== undefined && ask !== undefined && bid > 0 && ask > 0 && ask - bid <= 0.1) return (bid + ask) / 2;
  if (last !== undefined && last > 0) return last;
  if (bid !== undefined && ask !== undefined && ask > 0) return (bid + ask) / 2;
  return last ?? bid ?? ask ?? 0;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(res.status === 429 ? "The venue is busy. Try again in a moment." : `Couldn't load market data (${res.status}).`);
  return (await res.json()) as T;
}

// ---------------------------------------------------------------- Polymarket

interface GammaMarket {
  id: string;
  question: string;
  groupItemTitle?: string | null;
  outcomes?: string;
  outcomePrices?: string;
  clobTokenIds?: string;
  bestBid?: number;
  bestAsk?: number;
  lastTradePrice?: number;
  oneDayPriceChange?: number;
  volume24hr?: number;
  active?: boolean;
  closed?: boolean;
  acceptingOrders?: boolean;
  /** Sports games: "moneyline" for who wins; spreads, totals and props otherwise. */
  sportsMarketType?: string;
}
interface GammaEvent {
  id: string;
  slug: string;
  title: string;
  description?: string;
  endDate?: string;
  image?: string;
  volume?: number;
  volume24hr?: number;
  tags?: { label: string; slug: string }[];
  /** Mutually exclusive outcomes (one winner). */
  negRisk?: boolean;
  markets?: GammaMarket[];
}

const parseList = (s?: string): string[] => {
  try {
    const v = JSON.parse(s ?? "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};

/** `ranked`: sort by chance (for one-winner events); otherwise keep the venue's order (date ladders, thresholds). */
export function polymarketOutcomes(all: GammaMarket[] = [], ranked = true): Outcome[] {
  const out: Outcome[] = [];
  const live = all.filter((m) => !m.closed && m.active !== false && m.acceptingOrders !== false);
  // A game can carry hundreds of side markets (spreads, totals, props). Show who wins, like the venue does.
  const moneyline = live.filter((m) => m.sportsMarketType === "moneyline");
  const markets = moneyline.length ? moneyline : live;
  for (const m of markets) {
    const names = parseList(m.outcomes);
    const prices = parseList(m.outcomePrices).map(Number);
    const tokens = parseList(m.clobTokenIds);
    if (!tokens.length) continue;
    const bid = num(m.bestBid), ask = num(m.bestAsk), last = num(m.lastTradePrice);
    const yesNo = names.length === 2 && names[0]!.toLowerCase() === "yes" && names[1]!.toLowerCase() === "no";
    if (yesNo) {
      out.push({
        id: tokens[0]!, label: m.groupItemTitle || m.question, price: displayPrice(bid, ask, last ?? prices[0]),
        bid, ask, change24h: num(m.oneDayPriceChange), volume24h: num(m.volume24hr),
      });
      continue;
    }
    // Head-to-head markets (e.g. "Giants" vs "Eagles"): one row per side. The second side's book
    // is the mirror of the first's.
    // In an event with several such markets, say which market each side belongs to.
    const prefix = markets.length > 1 ? `${m.groupItemTitle || m.question} · ` : "";
    names.forEach((name, i) => {
      if (!tokens[i]) return;
      const label = prefix + name;
      const first = i === 0;
      const b = first ? bid : ask !== undefined ? 1 - ask : undefined;
      const a = first ? ask : bid !== undefined ? 1 - bid : undefined;
      const l = first ? last : last !== undefined ? 1 - last : undefined;
      const c = num(m.oneDayPriceChange);
      out.push({ id: tokens[i]!, label, price: displayPrice(b, a, l ?? prices[i]), bid: b, ask: a, change24h: c === undefined ? undefined : first ? c : -c, volume24h: num(m.volume24hr) });
    });
  }
  return ranked ? out.sort((x, y) => y.price - x.price) : out;
}

export function fromGamma(e: GammaEvent): PredictionEvent | null {
  // One market (yes/no or head-to-head) or a one-winner field: rank by chance. Ladders keep their order.
  const outcomes = polymarketOutcomes(e.markets, (e.markets?.length ?? 0) <= 1 || e.negRisk === true);
  if (!outcomes.length) return null;
  return {
    venue: "polymarket", id: e.id, title: e.title, category: e.tags?.[0]?.label, endDate: e.endDate,
    volume24h: num(e.volume24hr) ?? 0, volume: num(e.volume), image: e.image, rules: e.description,
    url: `${POLYMARKET_APP}/event/${encodeURIComponent(e.slug)}`, outcomes,
  };
}

export async function polymarketEvents(opts: { category?: Category; sort?: "volume" | "ending"; limit?: number } = {}): Promise<PredictionEvent[]> {
  const q = new URLSearchParams({ active: "true", closed: "false", limit: String(opts.limit ?? 30) });
  if (opts.sort === "ending") {
    q.set("order", "endDate");
    q.set("ascending", "true");
    q.set("end_date_min", new Date().toISOString());
  } else {
    q.set("order", "volume24hr");
    q.set("ascending", "false");
  }
  if (opts.category?.polyTag) q.set("tag_slug", opts.category.polyTag);
  const list = await getJson<GammaEvent[]>(`${POLYMARKET_GAMMA}/events?${q}`);
  return list.map(fromGamma).filter((e): e is PredictionEvent => !!e);
}

export async function polymarketSearch(query: string): Promise<PredictionEvent[]> {
  const q = new URLSearchParams({ q: query, limit_per_type: "20", events_status: "active" });
  const r = await getJson<{ events?: GammaEvent[] }>(`${POLYMARKET_GAMMA}/public-search?${q}`);
  return (r.events ?? []).map(fromGamma).filter((e): e is PredictionEvent => !!e);
}

// ---------------------------------------------------------------- Kalshi

interface KalshiMarket {
  ticker: string;
  title: string;
  yes_sub_title?: string;
  status: string;
  close_time?: string;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  last_price_dollars?: string;
  previous_price_dollars?: string;
  volume_24h_fp?: string;
  volume_fp?: string;
  rules_primary?: string;
  event_ticker?: string;
}
interface KalshiEvent {
  event_ticker: string;
  series_ticker: string;
  title: string;
  sub_title?: string;
  category?: string;
  markets?: KalshiMarket[];
}

export function fromKalshi(e: KalshiEvent): PredictionEvent | null {
  const live = (e.markets ?? []).filter((m) => m.status === "active" || m.status === "open");
  if (!live.length) return null;
  const outcomes: Outcome[] = live.map((m) => {
    const bid = num(m.yes_bid_dollars), ask = num(m.yes_ask_dollars), last = num(m.last_price_dollars), prev = num(m.previous_price_dollars);
    return {
      id: m.ticker, label: m.yes_sub_title || m.title, price: displayPrice(bid, ask, last), bid: bid || undefined, ask: ask || undefined,
      change24h: last !== undefined && prev !== undefined && prev > 0 ? last - prev : undefined, volume24h: num(m.volume_24h_fp), series: e.series_ticker,
    };
  }).sort((x, y) => y.price - x.price);
  const closes = live.map((m) => m.close_time).filter((t): t is string => !!t).sort();
  return {
    venue: "kalshi", id: e.event_ticker, title: e.title, subtitle: e.sub_title, category: e.category, endDate: closes[0],
    volume24h: live.reduce((s, m) => s + (num(m.volume_24h_fp) ?? 0), 0), volume: live.reduce((s, m) => s + (num(m.volume_fp) ?? 0), 0),
    rules: live[0]!.rules_primary, url: `${KALSHI_APP}/markets/${encodeURIComponent(e.series_ticker.toLowerCase())}`, outcomes,
  };
}

/** Kalshi's combo ("multivariate") events are parlays built from other markets; they're left out. */
const isCombo = (e: KalshiEvent) => e.series_ticker.startsWith("KXMVE") || e.event_ticker.startsWith("KXMVE");

/** Kalshi series codes are readable ("KXNFLGAME", "KXBTCD"), so markets without an event can be filed. */
const SERIES_CATEGORY: [RegExp, string][] = [
  [/BTC|ETH|SOL|XRP|DOGE|CRYPTO|COIN/, "Crypto"],
  [/NFL|NBA|MLB|NHL|NCAA|UEFA|EPL|LALIGA|SERIEA|BUNDES|MLS|ATP|WTA|F1|NASCAR|PGA|GOLF|UFC|BOX|SOCCER|FIFA|WC|GAME|MATCH|CUP|OPEN/, "Sports"],
  [/FED|CPI|GDP|JOBLESS|PAYROLL|U3|RATE|INFL|PCE|RECESS/, "Economics"],
  [/INX|NASDAQ|SPX|SP500|DOW|NDX|OIL|GOLD|TSLA|AAPL|NVDA|EARN/, "Financials"],
  [/TRUMP|TRUTH|SENATE|HOUSE|GOV|ELECT|PRES|CONGRESS|BILL|SCOTUS|MAYOR/, "Politics"],
  [/HIGH|TEMP|RAIN|SNOW|HURR|WEATHER|CLIMATE/, "Climate and Weather"],
  [/AI|OPENAI|GPT|SPACEX|TECH|APPLE|LLM/, "Science and Technology"],
  [/OSCAR|GRAMMY|EMMY|SPOTIFY|BILLBOARD|NETFLIX|MOVIE|BOXOFFICE|SONG|ALBUM|TOP/, "Entertainment"],
];
export function seriesOf(eventTicker: string): string {
  return eventTicker.split("-")[0]!;
}
export function guessCategory(series: string): string | undefined {
  const code = series.replace(/^KX/, "");
  return SERIES_CATEGORY.find(([re]) => re.test(code))?.[1];
}

/**
 * Names an event from its markets, the way Kalshi's site reads: a game from its rules
 * ("Turkiye vs Belgium"), a field from the shared question ("Will ___ be the NASCAR Cup Series Champion?").
 */
export function eventTitle(markets: KalshiMarket[]): string {
  const first = markets[0]!;
  if (markets.length === 1) return first.title;
  for (const m of markets) {
    const game = /\bthe (.{2,60}? vs\.? .{2,60}?) (?:professional|pro|men's|women's|college)\b/i.exec(m.rules_primary ?? "");
    // "…is the result of the Italy vs France game" → keep only what follows the last "the".
    if (game) return game[1]!.split(/\bthe /i).pop()!.trim();
  }
  return sharedTitle(markets.map((m) => m.title)) ?? first.title;
}

/**
 * The words every title shares, with "___" where they differ:
 * "Will Trump make below 60 posts…" + "Will Trump make 220+ posts…" → "Will Trump make ___ posts…".
 */
export function sharedTitle(titles: string[]): string | null {
  const words = titles.map((t) => t.split(" "));
  const shortest = Math.min(...words.map((w) => w.length));
  let pre = 0;
  while (pre < shortest && words.every((w) => w[pre] === words[0]![pre])) pre++;
  let suf = 0;
  while (suf < shortest - pre && words.every((w) => w[w.length - 1 - suf] === words[0]![words[0]!.length - 1 - suf])) suf++;
  if (pre === shortest) return null;
  const head = words[0]!.slice(0, pre).join(" "), tail = words[0]!.slice(words[0]!.length - suf).join(" ");
  if (head.length + tail.length < 12) return null;
  return [head, "___", tail].filter(Boolean).join(" ");
}

/** Groups a flat market list (from Kalshi's /markets) into events. */
export function eventsFromMarkets(markets: KalshiMarket[]): PredictionEvent[] {
  const groups = new Map<string, KalshiMarket[]>();
  for (const m of markets) {
    if (!m.event_ticker || m.event_ticker.startsWith("KXMVE")) continue;
    const list = groups.get(m.event_ticker) ?? [];
    list.push(m);
    groups.set(m.event_ticker, list);
  }
  return [...groups].flatMap(([ticker, ms]) => {
    const series = seriesOf(ticker);
    const ev = fromKalshi({ event_ticker: ticker, series_ticker: series, title: eventTitle(ms), category: guessCategory(series), markets: ms });
    return ev ? [ev] : [];
  });
}

let kalshiCache: { at: number; events: PredictionEvent[] } | null = null;
let kalshiPending: Promise<PredictionEvent[]> | null = null;

/**
 * Open Kalshi events, cached for two minutes and shared by every caller. Two lists load in
 * parallel: Kalshi's events page (long-range questions) and every market closing in the next
 * week (games, weekly and daily questions, where most trading happens), grouped into events.
 * Kalshi's API has no volume sort and answers slowly, so the wallet sorts here.
 */
export function kalshiAll(): Promise<PredictionEvent[]> {
  if (kalshiCache && Date.now() - kalshiCache.at < 120_000) return Promise.resolve(kalshiCache.events);
  kalshiPending ??= (async () => {
    try {
      // Round the window to the hour so the Worker's edge cache can share the answer.
      const hour = Math.floor(Date.now() / 3_600_000) * 3600;
      const [events, soon] = await Promise.allSettled([
        getJson<{ events: KalshiEvent[] }>(`${KALSHI_API}/events?${new URLSearchParams({ status: "open", with_nested_markets: "true", limit: "200" })}`),
        getJson<{ markets: KalshiMarket[] }>(`${KALSHI_API}/markets?${new URLSearchParams({ status: "open", mve_filter: "exclude", limit: "1000", min_close_ts: String(hour), max_close_ts: String(hour + 7 * 86_400) })}`),
      ]);
      if (events.status === "rejected" && soon.status === "rejected") throw events.reason;
      const byId = new Map<string, PredictionEvent>();
      if (soon.status === "fulfilled") for (const e of eventsFromMarkets(soon.value.markets ?? [])) byId.set(e.id, e);
      // The events page has full titles and categories, so it wins where both have an event.
      if (events.status === "fulfilled") {
        for (const e of events.value.events ?? []) {
          if (isCombo(e)) continue;
          const ev = fromKalshi(e);
          if (ev) byId.set(ev.id, ev);
        }
      }
      const list = [...byId.values()];
      kalshiCache = { at: Date.now(), events: list };
      return list;
    } finally {
      kalshiPending = null;
    }
  })();
  return kalshiPending;
}

export async function kalshiEvents(opts: { category?: Category; sort?: "volume" | "ending"; query?: string; limit?: number } = {}): Promise<PredictionEvent[]> {
  let list = await kalshiAll();
  if (opts.category?.kalshi) list = list.filter((e) => e.category && opts.category!.kalshi!.includes(e.category));
  if (opts.query) {
    const q = opts.query;
    list = list.filter((e) => matchesQuery(`${e.title} ${e.subtitle ?? ""} ${e.outcomes.map((o) => o.label).join(" ")}`, q));
  }
  list = [...list].sort(opts.sort === "ending"
    ? (a, b) => (a.endDate ?? "9").localeCompare(b.endDate ?? "9")
    : (a, b) => b.volume24h - a.volume24h);
  return list.slice(0, opts.limit ?? 30);
}

// ---------------------------------------------------------------- One event, books, history

export async function fetchEvent(venue: Venue, id: string): Promise<PredictionEvent | null> {
  if (venue === "polymarket") {
    const list = await getJson<GammaEvent[]>(`${POLYMARKET_GAMMA}/events?id=${encodeURIComponent(id)}`);
    return list[0] ? fromGamma(list[0]) : null;
  }
  const r = await getJson<{ event: KalshiEvent; markets?: KalshiMarket[] }>(`${KALSHI_API}/events/${encodeURIComponent(id)}?with_nested_markets=true`);
  return fromKalshi({ ...r.event, markets: r.event.markets ?? r.markets });
}

const levels = (rows: [string, string][] | { price: string; size: string }[] = []): BookLevel[] =>
  rows.map((r) => (Array.isArray(r) ? { price: Number(r[0]), size: Number(r[1]) } : { price: Number(r.price), size: Number(r.size) }))
    .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.size > 0);

/** Order book for the "yes" side of an outcome: bids high to low, asks low to high. */
export async function orderBook(venue: Venue, outcome: Outcome, depth = 8): Promise<OrderBook> {
  if (venue === "polymarket") {
    const b = await getJson<{ bids?: { price: string; size: string }[]; asks?: { price: string; size: string }[] }>(`${POLYMARKET_CLOB}/book?token_id=${encodeURIComponent(outcome.id)}`);
    return normalizeBook(levels(b.bids), levels(b.asks), depth);
  }
  const r = await getJson<{ orderbook_fp?: { yes_dollars?: [string, string][] | null; no_dollars?: [string, string][] | null } }>(`${KALSHI_API}/markets/${encodeURIComponent(outcome.id)}/orderbook?depth=${depth}`);
  return kalshiBook(r.orderbook_fp?.yes_dollars ?? [], r.orderbook_fp?.no_dollars ?? [], depth);
}

export function normalizeBook(bids: BookLevel[], asks: BookLevel[], depth = 8): OrderBook {
  return { bids: [...bids].sort((a, b) => b.price - a.price).slice(0, depth), asks: [...asks].sort((a, b) => a.price - b.price).slice(0, depth) };
}

/** Kalshi lists bids on each side. A bid for "no" at p is an offer to sell "yes" at 1 − p. */
export function kalshiBook(yesBids: [string, string][], noBids: [string, string][], depth = 8): OrderBook {
  const asks = levels(noBids).map((l) => ({ price: Math.round((1 - l.price) * 10_000) / 10_000, size: l.size }));
  return normalizeBook(levels(yesBids), asks, depth);
}

export async function priceHistory(venue: Venue, outcome: Outcome, range: HistoryRange): Promise<PricePoint[]> {
  const now = Math.floor(Date.now() / 1000);
  const span = { "1d": 86_400, "1w": 7 * 86_400, "1m": 30 * 86_400 }[range];
  if (venue === "polymarket") {
    const fidelity = { "1d": 10, "1w": 60, "1m": 240 }[range];
    const r = await getJson<{ history?: { t: number; p: number }[] }>(`${POLYMARKET_CLOB}/prices-history?market=${encodeURIComponent(outcome.id)}&startTs=${now - span}&fidelity=${fidelity}`);
    return (r.history ?? []).map((h) => ({ t: h.t * 1000, p: h.p }));
  }
  if (!outcome.series) return [];
  const interval = range === "1m" ? 1440 : 60;
  const r = await getJson<{ candlesticks?: KalshiCandle[] }>(
    `${KALSHI_API}/series/${encodeURIComponent(outcome.series)}/markets/${encodeURIComponent(outcome.id)}/candlesticks?start_ts=${now - span}&end_ts=${now}&period_interval=${interval}`,
  );
  return kalshiHistory(r.candlesticks ?? []);
}

interface KalshiCandle {
  end_period_ts: number;
  price?: { close_dollars?: string | null };
  yes_bid?: { close_dollars?: string | null };
  yes_ask?: { close_dollars?: string | null };
}

/** Last trade per candle; when nothing traded, the middle of the closing bid and ask. */
export function kalshiHistory(candles: KalshiCandle[]): PricePoint[] {
  return candles.flatMap((c) => {
    const last = num(c.price?.close_dollars);
    const bid = num(c.yes_bid?.close_dollars), ask = num(c.yes_ask?.close_dollars);
    const p = last ?? (bid !== undefined && ask !== undefined ? (bid + ask) / 2 : undefined);
    return p === undefined ? [] : [{ t: c.end_period_ts * 1000, p }];
  });
}

// ---------------------------------------------------------------- Positions

export interface PredictionPosition {
  title: string;
  outcome: string;
  size: number;
  avgPrice: number;
  value: number;
  pnl: number;
}

/** Polymarket positions held by this wallet's address (Kalshi accounts are separate, on Kalshi). */
export async function polymarketPositions(address: string): Promise<PredictionPosition[]> {
  const r = await getJson<{ data?: Record<string, unknown>[] }>(`${POLYMARKET_DATA}/positions?user=${encodeURIComponent(address)}&limit=50`);
  return (r.data ?? []).map((p) => ({
    title: String(p.title ?? ""), outcome: String(p.outcome ?? ""), size: num(p.current_size) ?? 0, avgPrice: num(p.avg_price) ?? 0,
    value: num(p.current_value) ?? 0, pnl: (num(p.unrealized_pnl) ?? 0) + (num(p.realized_pnl) ?? 0),
  })).filter((p) => p.size > 0);
}

// ---------------------------------------------------------------- Math

export interface BuyQuote {
  shares: number;
  /** What the shares pay if this side wins ($1 each). */
  payout: number;
  profit: number;
  /** Estimated venue fee (Kalshi's published taker fee; Polymarket shows its own). */
  fee: number;
  /** Chance the price implies, after fees. */
  breakEven: number;
}

/**
 * Buying `usd` worth of one side at `price` (0..1). Kalshi charges a taker fee of
 * 7% × contracts × P × (1 − P), rounded up to the cent; Polymarket's fees vary by market.
 */
export function buyQuote(venue: Venue, price: number, usd: number): BuyQuote {
  if (!(price > 0 && price < 1) || !(usd > 0)) return { shares: 0, payout: 0, profit: 0, fee: 0, breakEven: 0 };
  let shares = usd / price;
  let fee = 0;
  if (venue === "kalshi") {
    shares = Math.floor(shares);
    fee = Math.ceil(0.07 * shares * price * (1 - price) * 100 - 1e-9) / 100;
    // Keep the total (cost + fee) within the amount entered.
    while (shares > 0 && shares * price + fee > usd + 1e-9) {
      shares -= 1;
      fee = Math.ceil(0.07 * shares * price * (1 - price) * 100 - 1e-9) / 100;
    }
  }
  const cost = shares * price + fee;
  return { shares, payout: shares, profit: shares - cost, fee, breakEven: shares > 0 ? cost / shares : 0 };
}

const STOP = new Set("a an and are at be by for from has have in is it of on or the to will with who what which when vs v before after by end this that next than more less than over under 2025 2026 2027".split(" "));
export function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9$%. ]+/g, " ").split(/\s+/).map((w) => w.replace(/\.$/, "")).filter((w) => w.length > 1 && !STOP.has(w)));
}

/** Plain singular form, so "rates" finds "rate" and "elections" finds "election". */
const stem = (w: string) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);

/** True when every search word appears in the text (ignoring plurals; a word can be the start of a longer one). */
export function matchesQuery(text: string, query: string): boolean {
  const have = [...tokens(text)].map(stem);
  return [...tokens(query)].map(stem).every((w) => have.some((t) => t === w || t.startsWith(w)));
}

/** Similar questions on the other venue, by shared words in the titles and outcomes. */
export function similarEvents(event: PredictionEvent, others: PredictionEvent[], max = 3): { event: PredictionEvent; score: number }[] {
  const a = tokens(`${event.title} ${event.subtitle ?? ""}`);
  return others
    .filter((o) => o.venue !== event.venue)
    .map((o) => {
      const b = tokens(`${o.title} ${o.subtitle ?? ""}`);
      let shared = 0;
      for (const w of a) if (b.has(w)) shared++;
      return { event: o, score: shared < 2 ? 0 : shared / (a.size + b.size - shared) };
    })
    .filter((m) => m.score >= 0.34)
    .sort((x, y) => y.score - x.score)
    .slice(0, max);
}

/** Alerts whose condition is now met. */
export function triggeredAlerts(alerts: PriceAlert[], prices: Map<string, number>): PriceAlert[] {
  return alerts.filter((a) => {
    const p = prices.get(`${a.venue}:${a.outcomeId}`);
    return p !== undefined && (a.above ? p >= a.price : p <= a.price);
  });
}

/**
 * Crypto price questions ("Bitcoin above $100,000 on Dec 31?") that Conjure's on-device model can
 * price itself. Returns the coin, strike and direction, or null.
 */
export interface CryptoThreshold {
  coin: "BTC" | "ETH" | "SOL";
  strike: number;
  above: boolean;
  /** "Hit / reach / dip to" questions resolve if the price touches the level at any point. */
  touch: boolean;
}

export function cryptoThreshold(title: string, label: string): CryptoThreshold | null {
  const text = `${title} ${label}`.toLowerCase();
  const coin = /\b(bitcoin|btc)\b/.test(text) ? "BTC" : /\b(ethereum|eth|ether)\b/.test(text) ? "ETH" : /\b(solana|sol)\b/.test(text) ? "SOL" : null;
  if (!coin) return null;
  // An arrow on the outcome ("↑ 120,000", "↓ 2,000") decides; otherwise the wording does.
  const arrowUp = label.includes("↑"), arrowDown = label.includes("↓");
  const below = arrowDown || (!arrowUp && /\b(below|under|dip|less than|fall)\b/.test(text));
  const above = arrowUp || (!arrowDown && /\b(above|over|reach|hit|greater|exceed|more than)\b/.test(text));
  if (above === below) return null;
  const pick = (s: string) => {
    const m = /\$?\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k|m)?\b/i.exec(s);
    if (!m) return undefined;
    const n = Number(m[1]!.replace(/,/g, "")) * (m[2]?.toLowerCase() === "k" ? 1e3 : m[2]?.toLowerCase() === "m" ? 1e6 : 1);
    return n >= 1 ? n : undefined;
  };
  const strike = pick(label) ?? pick(title.replace(/\b(20\d\d)\b/g, ""));
  const touch = /\b(hit|reach|touch|dip)\b/.test(text);
  return strike ? { coin, strike, above: !below, touch } : null;
}

/**
 * Chance a threshold question resolves yes. End-of-period questions use the chance of finishing
 * past the strike. Touch questions use the reflection principle: with no drift, the chance of
 * touching a level not yet reached is about twice the chance of finishing past it.
 */
export function thresholdChance(t: CryptoThreshold, spot: number, pAboveAtEnd: number): number {
  const pastAtEnd = t.above ? pAboveAtEnd : 1 - pAboveAtEnd;
  if (!t.touch) return pastAtEnd;
  const alreadyThere = t.above ? spot >= t.strike : spot <= t.strike;
  return alreadyThere ? 1 : Math.min(1, 2 * pastAtEnd);
}
