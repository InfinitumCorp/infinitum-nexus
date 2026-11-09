/**
 * Free daily price history for Conjure Markets:
 * - crypto and every perp market: Hyperliquid's public candle API (no key, CORS open);
 * - tokenized stocks: the token's own daily prices from its most liquid Solana pool, via
 *   GeckoTerminal's free public API (no key, CORS open).
 */
import type { Candle } from "@infinitum/conjure/markets";
import { HYPERLIQUID_API } from "./config.ts";

const DAY = 86_400_000;

export async function cryptoCandles(coin: string, days = 365, fetchImpl: typeof fetch = fetch): Promise<Candle[]> {
  const end = Date.now();
  // Prices always come from mainnet: testnet prices aren't real market history.
  const res = await fetchImpl(`${HYPERLIQUID_API.mainnet}/info`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "candleSnapshot", req: { coin, interval: "1d", startTime: end - days * DAY, endTime: end } }),
  });
  if (!res.ok) throw new Error(`No price history for ${coin}.`);
  const rows = (await res.json()) as { T: number; c: string }[];
  return rows.map((r) => ({ t: r.T, close: Number(r.c) }));
}

const GECKO = (import.meta.env?.VITE_GECKOTERMINAL_API as string | undefined) ?? "https://api.geckoterminal.com/api/v2";

/** Daily closes for a Solana token (e.g. an xStock) from its deepest pool. */
export async function tokenCandles(mint: string, fetchImpl: typeof fetch = fetch): Promise<Candle[]> {
  const pools = await fetchImpl(`${GECKO}/networks/solana/tokens/${mint}/pools?page=1`);
  if (!pools.ok) throw new Error("No price history for this token right now.");
  const list = ((await pools.json()) as { data: { attributes: { address: string; reserve_in_usd: string } }[] }).data;
  const best = [...list].sort((a, b) => Number(b.attributes.reserve_in_usd) - Number(a.attributes.reserve_in_usd))[0];
  if (!best) throw new Error("This token has no trading pool yet.");
  const res = await fetchImpl(`${GECKO}/networks/solana/pools/${best.attributes.address}/ohlcv/day?limit=1000&currency=usd&token=${mint}`);
  if (!res.ok) throw new Error("No price history for this token right now.");
  return parseGeckoOhlcv(await res.json());
}

/** GeckoTerminal OHLCV rows are [unix seconds, open, high, low, close, volume], newest first. */
export function parseGeckoOhlcv(json: unknown): Candle[] {
  const rows = (json as { data?: { attributes?: { ohlcv_list?: number[][] } } })?.data?.attributes?.ohlcv_list ?? [];
  return rows.flatMap((r) => (Number.isFinite(r[0]) && r[4]! > 0 ? [{ t: r[0]! * 1000, close: r[4]! }] : [])).sort((a, b) => a.t - b.t);
}

/** Which Hyperliquid coin to use for a wallet asset's history. */
export function historyCoin(symbol: string): string | null {
  const s = symbol.toUpperCase();
  if (["ETH", "WETH"].includes(s)) return "ETH";
  if (["SOL", "WSOL"].includes(s)) return "SOL";
  if (["WBTC", "CBBTC", "BTC"].includes(s)) return "BTC";
  if (s === "USDC") return null;
  return s;
}
