/**
 * The mini app's on-chain order book: Hyperliquid perps and spot, in one list of tickers.
 *
 * Spot pairs trade as asset 10000 + the pair's index, with prices of at most 5 significant figures
 * and (8 − szDecimals) decimals. Orders are signed with the wallet's own key (see perps.ts) and
 * sent straight from the device to Hyperliquid; nothing goes through Infinitum.
 */
import type { Address } from "viem";
import type { HDAccount } from "viem/accounts";
import type { NetworkMode } from "./config.ts";
import { estimateLiquidation, MAX_WALLET_LEVERAGE, post, roundPrice, wire, type PerpMarket, type PreparedPerpOrder } from "./perps.ts";

export interface Ticker {
  kind: "perp" | "spot";
  /** Hyperliquid's name for the market: "BTC" for a perp, "@107" or "PURR/USDC" for spot. */
  coin: string;
  /** What people call it: "BTC", "HYPE/USDC". */
  label: string;
  /** The base token's name ("HYPE"); same as coin for perps. */
  base: string;
  asset: number;
  szDecimals: number;
  maxLeverage: number;
  mid?: number;
  prevDayPx?: number;
  change24h?: number;
  volume24h: number;
  /** Hourly funding rate (perps). */
  funding?: number;
}

interface PerpMeta { universe: { name: string; szDecimals: number; maxLeverage: number; isDelisted?: boolean }[] }
interface PerpCtx { midPx?: string | null; markPx?: string; prevDayPx?: string; dayNtlVlm?: string; funding?: string }
interface SpotMeta { tokens: { name: string; szDecimals: number; index: number }[]; universe: { name: string; tokens: [number, number]; index: number }[] }
interface SpotCtx extends PerpCtx { coin: string }

const change = (mid: number | undefined, prev: string | undefined) => (mid && Number(prev) > 0 ? mid / Number(prev) - 1 : undefined);
const midOf = (c?: PerpCtx) => {
  const m = Number(c?.midPx ?? c?.markPx);
  return m > 0 ? m : undefined;
};

/** Perps line up with their contexts by position; spot contexts are matched by coin name. Only USDC spot pairs are listed. */
export function parseTickers(perp: [PerpMeta, PerpCtx[]], spot: [SpotMeta, SpotCtx[]]): Ticker[] {
  const out: Ticker[] = [];
  perp[0].universe.forEach((u, i) => {
    if (u.isDelisted) return;
    const c = perp[1][i];
    const mid = midOf(c);
    out.push({
      kind: "perp", coin: u.name, label: u.name, base: u.name, asset: i, szDecimals: u.szDecimals, maxLeverage: u.maxLeverage,
      mid, prevDayPx: Number(c?.prevDayPx) || undefined, change24h: change(mid, c?.prevDayPx), volume24h: Number(c?.dayNtlVlm ?? 0), funding: c?.funding !== undefined ? Number(c.funding) : undefined,
    });
  });
  const tokens = new Map(spot[0].tokens.map((t) => [t.index, t]));
  const ctx = new Map(spot[1].map((c) => [c.coin, c]));
  for (const u of spot[0].universe) {
    const base = tokens.get(u.tokens[0]);
    const quote = tokens.get(u.tokens[1]);
    if (!base || quote?.name !== "USDC") continue;
    const c = ctx.get(u.name);
    const mid = midOf(c);
    out.push({
      kind: "spot", coin: u.name, label: `${base.name}/USDC`, base: base.name, asset: 10_000 + u.index, szDecimals: base.szDecimals, maxLeverage: 1,
      mid, prevDayPx: Number(c?.prevDayPx) || undefined, change24h: change(mid, c?.prevDayPx), volume24h: Number(c?.dayNtlVlm ?? 0),
    });
  }
  return out;
}

const EMPTY_PERP: [PerpMeta, PerpCtx[]] = [{ universe: [] }, []];
const EMPTY_SPOT: [SpotMeta, SpotCtx[]] = [{ tokens: [], universe: [] }, []];

/** Fresh prices (allMids, keyed by the same coin names) over a cached list. */
export function withMids(list: Ticker[], mids: Record<string, string>): Ticker[] {
  return list.map((t) => {
    const mid = Number(mids[t.coin]);
    return mid > 0 ? { ...t, mid, change24h: t.prevDayPx ? mid / t.prevDayPx - 1 : t.change24h } : t;
  });
}

const FULL_EVERY = 5 * 60_000;
const cache = new Map<string, { at: number; list: Ticker[] }>();
const pending = new Map<string, Promise<Ticker[]>>();

/** One market type's list: cached per network and type, shared by every screen asking at once. */
function kindTickers(mode: NetworkMode, kind: Ticker["kind"]): Promise<Ticker[]> {
  const key = `${mode}:${kind}`;
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const job = (async () => {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < FULL_EVERY) {
      const mids = await post<Record<string, string>>(mode, "info", { type: "allMids" }).catch(() => null);
      if (mids) hit.list = withMids(hit.list, mids);
      return hit.list;
    }
    const list = kind === "perp"
      ? parseTickers(await post<[PerpMeta, PerpCtx[]]>(mode, "info", { type: "metaAndAssetCtxs" }), EMPTY_SPOT)
      : parseTickers(EMPTY_PERP, await post<[SpotMeta, SpotCtx[]]>(mode, "info", { type: "spotMetaAndAssetCtxs" }));
    cache.set(key, { at: Date.now(), list });
    return list;
  })().finally(() => pending.delete(key));
  pending.set(key, job);
  return job;
}

/**
 * Market lists. The full lists (the spot one is ~360 KB on mainnet, ~1 MB on testnet) are fetched
 * at most every 5 minutes; in between only prices are refreshed from allMids (~25 KB), which is
 * kinder to mobile data. One type failing (testnet can be slow) doesn't hide the other.
 */
export async function tickers(mode: NetworkMode, kinds: Ticker["kind"][] = ["perp", "spot"]): Promise<Ticker[]> {
  const parts = await Promise.allSettled(kinds.map((k) => kindTickers(mode, k)));
  const ok = parts.flatMap((p) => (p.status === "fulfilled" ? p.value : []));
  const firstError = parts.find((p): p is PromiseRejectedResult => p.status === "rejected");
  if (!ok.length && firstError) throw firstError.reason;
  return ok;
}

export const asPerpMarket = (t: Ticker): PerpMarket => ({ index: t.asset, name: t.coin, szDecimals: t.szDecimals, maxLeverage: t.maxLeverage, mid: t.mid });

export interface SpotBalance { coin: string; total: number; hold: number }

export async function spotBalances(mode: NetworkMode, user: Address): Promise<SpotBalance[]> {
  const r = await post<{ balances: { coin: string; total: string; hold: string }[] }>(mode, "info", { type: "spotClearinghouseState", user });
  return r.balances.map((b) => ({ coin: b.coin, total: Number(b.total), hold: Number(b.hold) })).filter((b) => b.total > 0);
}

export interface SpotOrderInput {
  ticker: Ticker;
  side: "buy" | "sell";
  /** Buy: USDC to spend. */
  usd?: number;
  /** Sell: how much of the base token to sell. */
  size?: number;
  limitPx?: number;
  slippage?: number;
}

export function prepareSpotOrder(input: SpotOrderInput): PreparedPerpOrder {
  const { ticker: t, side } = input;
  if (t.kind !== "spot") throw new Error("Not a spot market.");
  if (!t.mid) throw new Error("No price for this market right now.");
  const isBuy = side === "buy";
  const px = input.limitPx ?? t.mid * (isBuy ? 1 + (input.slippage ?? 0.01) : 1 - (input.slippage ?? 0.01));
  const raw = isBuy ? (input.usd ?? 0) / t.mid : (input.size ?? 0);
  // Round sizes down so a sell never asks for more than the balance.
  const size = Math.floor(raw * 10 ** t.szDecimals) / 10 ** t.szDecimals;
  if (!(size > 0)) throw new Error("That amount rounds to zero for this market.");
  const notional = size * t.mid;
  if (notional < 10) throw new Error("Hyperliquid's minimum order is $10.");
  const order = { a: t.asset, b: isBuy, p: roundPrice(px, t.szDecimals, 8), s: wire(size, t.szDecimals), r: false, t: { limit: { tif: input.limitPx ? "Gtc" : "Ioc" } } };
  return {
    title: `${isBuy ? "Buy" : "Sell"} ${t.base}`,
    details: [
      ["Pair", `${t.label} spot`],
      ["Amount", `${order.s} ${t.base} (≈ $${notional.toFixed(2)})`],
      ["Order", input.limitPx ? `Limit at ${order.p}` : `Market (fills up to ${order.p})`],
      ["Venue", "Hyperliquid spot (fees set by Hyperliquid; Infinitum adds none)"],
    ],
    actions: [{ type: "order", orders: [order], grouping: "na" }],
  };
}

/** Quick leverage choices for the mini ticket, within the market's and the wallet's caps. */
export function leverageSteps(maxLeverage: number): number[] {
  const cap = Math.min(maxLeverage, MAX_WALLET_LEVERAGE);
  return [1, 2, 3, 5, 10].filter((x) => x <= cap);
}

/** One line the mini ticket shows under the button. */
export function ticketSummary(t: Ticker, side: "long" | "short", usd: number, leverage: number): string {
  if (!t.mid || !(usd > 0)) return "";
  if (t.kind === "spot") return `≈ ${(usd / t.mid).toFixed(Math.min(t.szDecimals, 6))} ${t.base}`;
  const liq = estimateLiquidation(side, t.mid, leverage, t.maxLeverage);
  return `Margin ≈ $${(usd / leverage).toFixed(2)} · liq. ≈ ${liq.toPrecision(5)}`;
}

/**
 * Move USDC between the perps and spot balances (bridge deposits land in perps). This is a
 * "user-signed" action, signed like Hyperliquid's own SDK: EIP-712 domain HyperliquidSignTransaction
 * on signature chain 0x66eee, with hyperliquidChain naming the environment so it can't be replayed.
 */
export function usdTransferTypedData(mode: NetworkMode, amount: number, toPerp: boolean, nonce: number) {
  const action = {
    type: "usdClassTransfer", amount: wire(amount, 6), toPerp, nonce,
    signatureChainId: "0x66eee", hyperliquidChain: mode === "mainnet" ? "Mainnet" : "Testnet",
  } as const;
  const typed = {
    domain: { name: "HyperliquidSignTransaction", version: "1", chainId: 0x66eee, verifyingContract: "0x0000000000000000000000000000000000000000" as Address },
    types: {
      "HyperliquidTransaction:UsdClassTransfer": [
        { name: "hyperliquidChain", type: "string" }, { name: "amount", type: "string" }, { name: "toPerp", type: "bool" }, { name: "nonce", type: "uint64" },
      ],
    },
    primaryType: "HyperliquidTransaction:UsdClassTransfer" as const,
    message: { hyperliquidChain: action.hyperliquidChain, amount: action.amount, toPerp, nonce: BigInt(nonce) },
  };
  return { action, typed };
}

export async function usdTransfer(mode: NetworkMode, account: HDAccount, amount: number, toPerp: boolean): Promise<void> {
  if (!(amount > 0)) throw new Error("Enter an amount.");
  const nonce = Date.now();
  const { action, typed } = usdTransferTypedData(mode, amount, toPerp, nonce);
  const sig = await account.signTypedData(typed);
  const signature = { r: `0x${sig.slice(2, 66)}`, s: `0x${sig.slice(66, 130)}`, v: Number.parseInt(sig.slice(130, 132), 16) };
  const r = await post<{ status: string; response?: unknown }>(mode, "exchange", { action, nonce, signature, vaultAddress: null });
  if (r.status !== "ok") throw new Error(typeof r.response === "string" ? r.response : "Hyperliquid didn't accept the transfer.");
}

/** Hyperliquid's order ids need the asset number to cancel: perps by name, spot by "@index". */
export function assetForCoin(coin: string, list: Ticker[]): number | undefined {
  return list.find((t) => t.coin === coin)?.asset;
}
