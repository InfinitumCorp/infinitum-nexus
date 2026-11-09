/**
 * Tokenized stocks: xStocks (Backed Finance) on Solana, SPL Token-2022 tokens that each wrap one
 * share's worth of a listed stock or ETF. Mints are discovered at runtime from Jupiter's free
 * token API (verified tokens only) instead of hard-coding addresses, and swapped through Jupiter
 * like any other Solana token. Use is subject to the venue's own terms.
 */
import type { TokenInfo } from "./config.ts";

const TOKENS_API = (import.meta.env?.VITE_JUPITER_TOKENS_API as string | undefined) ?? "https://lite-api.jup.ag/tokens/v2";

interface JupToken {
  id: string;
  name: string;
  symbol: string;
  decimals: number;
  icon?: string;
  isVerified?: boolean;
  usdPrice?: number;
  tags?: string[];
}

export interface StockToken extends TokenInfo {
  icon?: string;
  usdPrice?: number;
}

/** Turn Jupiter token rows into xStocks entries: verified only, named "... xStock". */
export function toStocks(rows: JupToken[]): StockToken[] {
  const seen = new Set<string>();
  const out: StockToken[] = [];
  for (const r of rows) {
    if (!r.isVerified || !/xstock/i.test(r.name) || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({
      chain: "solana", symbol: r.symbol, name: r.name, decimals: r.decimals, address: r.id,
      category: "stock", underlying: r.symbol.replace(/x$/i, "").toUpperCase(), icon: r.icon, usdPrice: r.usdPrice,
    });
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export async function discoverStocks(query = "xStock", fetchImpl: typeof fetch = fetch): Promise<StockToken[]> {
  const res = await fetchImpl(`${TOKENS_API}/search?query=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error("Couldn't load tokenized stocks right now.");
  return toStocks((await res.json()) as JupToken[]);
}
