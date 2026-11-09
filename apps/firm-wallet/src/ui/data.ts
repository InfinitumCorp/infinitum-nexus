/** Portfolio loading: every chain at once, priced from Hyperliquid's free mid prices. */
import { formatUnits } from "viem";
import { CHAIN_KEYS, CHAINS, HYPERLIQUID_API, tokensFor, type ChainKey, type NetworkMode, type TokenInfo } from "../core/config.ts";
import { evmBalances } from "../core/evm.ts";
import { solBalance, splHoldings } from "../core/solana.ts";
import { historyCoin } from "../core/market-data.ts";
import type { Session } from "./store.ts";

export interface Holding {
  token: TokenInfo;
  amount: number;
  raw: bigint;
  usd?: number;
}

export interface ChainPortfolio {
  chain: ChainKey;
  name: string;
  address: string;
  holdings: Holding[];
  error?: string;
}

let midsCache: { at: number; mids: Record<string, number> } | null = null;

export async function prices(): Promise<Record<string, number>> {
  if (midsCache && Date.now() - midsCache.at < 30_000) return midsCache.mids;
  try {
    const res = await fetch(`${HYPERLIQUID_API.mainnet}/info`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "allMids" }) });
    const raw = (await res.json()) as Record<string, string>;
    const mids = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Number(v)]));
    midsCache = { at: Date.now(), mids };
    return mids;
  } catch {
    return midsCache?.mids ?? {};
  }
}

export function priceOf(token: TokenInfo, mids: Record<string, number>): number | undefined {
  if (token.symbol === "USDC") return 1;
  const coin = historyCoin(token.symbol);
  return coin ? mids[coin] : undefined;
}

export async function loadPortfolio(mode: NetworkMode, session: Session, custom: TokenInfo[], extraSolana: TokenInfo[] = []): Promise<ChainPortfolio[]> {
  const mids = await prices();
  return Promise.all(
    CHAIN_KEYS.map(async (chain): Promise<ChainPortfolio> => {
      const tokens = tokensFor(mode, chain, custom);
      const name = CHAINS[mode][chain].name;
      try {
        if (chain === "solana") {
          const owner = session.sol.address;
          const [lamports, spl] = await Promise.all([solBalance(mode, owner), splHoldings(mode, owner)]);
          const known = [...tokens, ...extraSolana];
          const holdings: Holding[] = [{ token: tokens[0]!, raw: lamports, amount: Number(formatUnits(lamports, 9)) }];
          for (const h of spl) {
            if (h.amount === 0n) continue;
            const token = known.find((t) => t.address === h.mint) ?? { chain, symbol: `${h.mint.slice(0, 4)}…`, name: "Unknown token", decimals: h.decimals, address: h.mint };
            holdings.push({ token: { ...token, decimals: h.decimals }, raw: h.amount, amount: Number(formatUnits(h.amount, h.decimals)) });
          }
          for (const t of tokens.filter((x) => x.symbol === "USDC" || (x.infinitum && x.address))) {
            if (!holdings.some((h) => h.token.address === t.address)) holdings.push({ token: t, raw: 0n, amount: 0 });
          }
          return { chain, name, address: owner, holdings: holdings.map((h) => withUsd(h, mids)) };
        }
        const owner = session.evm.address;
        const balances = await evmBalances(mode, chain, owner, tokens);
        const holdings = tokens
          .filter((t) => balances[t.symbol] !== undefined)
          .map((t) => withUsd({ token: t, raw: balances[t.symbol]!, amount: Number(formatUnits(balances[t.symbol]!, t.decimals)) }, mids));
        return { chain, name, address: owner, holdings };
      } catch (e) {
        return { chain, name, address: chain === "solana" ? session.sol.address : session.evm.address, holdings: [], error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
}

function withUsd(h: Holding, mids: Record<string, number>): Holding {
  const p = (h.token as TokenInfo & { usdPrice?: number }).usdPrice ?? priceOf(h.token, mids);
  return { ...h, usd: p === undefined ? undefined : p * h.amount };
}
