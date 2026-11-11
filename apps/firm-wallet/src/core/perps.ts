/**
 * Perpetual futures on Hyperliquid, traded from $FIRM Wallet™ with the wallet's own EVM key.
 *
 * Hyperliquid's API is open and free. Each action is MessagePack-encoded, hashed with the nonce
 * (keccak256), and signed as an EIP-712 "Agent" message; the private key never leaves the device.
 * The wallet only ever sends orders the person has reviewed (size, leverage, estimated
 * liquidation price). Funding is a USDC deposit to Hyperliquid's bridge on Arbitrum.
 *
 * Perps are leveraged and can lose more than the margin you post on that position.
 * Use is subject to the venue's own terms.
 */
import { keccak256, type Address, type Hex } from "viem";
import type { HDAccount } from "viem/accounts";
import { HYPERLIQUID_API, type NetworkMode } from "./config.ts";

/* ---------------- MessagePack (only what Hyperliquid actions need; key order kept) ---------------- */

export function msgpack(value: unknown): Uint8Array {
  const out: number[] = [];
  const enc = new TextEncoder();
  const w = (v: unknown): void => {
    if (v === null || v === undefined) out.push(0xc0);
    else if (v === true) out.push(0xc3);
    else if (v === false) out.push(0xc2);
    else if (typeof v === "number") {
      if (!Number.isInteger(v) || v < 0) throw new Error("msgpack: only non-negative integers are used in actions");
      if (v < 128) out.push(v);
      else if (v < 256) out.push(0xcc, v);
      else if (v < 65536) out.push(0xcd, v >> 8, v & 255);
      else if (v < 2 ** 32) out.push(0xce, (v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
      else {
        const b = new Uint8Array(8);
        new DataView(b.buffer).setBigUint64(0, BigInt(v));
        out.push(0xcf, ...b);
      }
    } else if (typeof v === "string") {
      const b = enc.encode(v);
      if (b.length < 32) out.push(0xa0 | b.length);
      else if (b.length < 256) out.push(0xd9, b.length);
      else out.push(0xda, b.length >> 8, b.length & 255);
      out.push(...b);
    } else if (Array.isArray(v)) {
      if (v.length < 16) out.push(0x90 | v.length);
      else out.push(0xdc, v.length >> 8, v.length & 255);
      v.forEach(w);
    } else if (typeof v === "object") {
      const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
      if (entries.length < 16) out.push(0x80 | entries.length);
      else out.push(0xde, entries.length >> 8, entries.length & 255);
      for (const [k, x] of entries) {
        w(k);
        w(x);
      }
    } else throw new Error(`msgpack: unsupported ${typeof v}`);
  };
  w(value);
  return Uint8Array.from(out);
}

export function actionHash(action: unknown, nonce: number): Hex {
  const body = msgpack(action);
  const buf = new Uint8Array(body.length + 9);
  buf.set(body);
  new DataView(buf.buffer).setBigUint64(body.length, BigInt(nonce));
  buf[body.length + 8] = 0; // no vault address
  return keccak256(buf);
}

export async function signL1Action(account: HDAccount, action: unknown, nonce: number, mainnet: boolean) {
  const connectionId = actionHash(action, nonce);
  const sig = await account.signTypedData({
    domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: "0x0000000000000000000000000000000000000000" },
    types: { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
    primaryType: "Agent",
    message: { source: mainnet ? "a" : "b", connectionId },
  });
  return { r: `0x${sig.slice(2, 66)}`, s: `0x${sig.slice(66, 130)}`, v: Number.parseInt(sig.slice(130, 132), 16) };
}

/* ---------------- Number formatting rules ---------------- */

/** Hyperliquid wants decimal strings with no trailing zeros. */
export function wire(n: number, decimals: number): string {
  const s = n.toFixed(decimals);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** Prices: at most 5 significant figures and at most (6 − szDecimals) decimals (8 − szDecimals for spot). */
export function roundPrice(px: number, szDecimals: number, maxDecimals = 6): string {
  if (Number.isInteger(px)) return String(px);
  const sig = Number(px.toPrecision(5));
  return wire(sig, Math.max(0, maxDecimals - szDecimals));
}

/* ---------------- API ---------------- */

export interface PerpMarket {
  index: number;
  name: string;
  szDecimals: number;
  maxLeverage: number;
  mid?: number;
}

export interface PerpPosition {
  coin: string;
  size: number;
  entryPx: number;
  positionValue: number;
  unrealizedPnl: number;
  leverage: number;
  liquidationPx: number | null;
}

export interface PerpAccount {
  accountValue: number;
  withdrawable: number;
  marginUsed: number;
  positions: PerpPosition[];
  openOrders: { coin: string; oid: number; side: "B" | "A"; limitPx: string; sz: string }[];
}

export async function post<T>(mode: NetworkMode, path: "info" | "exchange", body: unknown): Promise<T> {
  // Reads give up after 60 s (the spot list is ~360 KB, slow on a weak phone signal) so a stuck
  // request can't freeze a screen. Orders never time out on our side: aborting one wouldn't tell us
  // whether Hyperliquid accepted it.
  const reading = path === "info";
  const failed = (e: unknown): never => {
    const name = (e as Error)?.name;
    throw new Error(name === "TimeoutError" || name === "AbortError" ? "Hyperliquid is slow to answer. Try again in a moment." : "Can't reach Hyperliquid right now.");
  };
  const res = await fetch(`${HYPERLIQUID_API[mode]}/${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    signal: reading ? AbortSignal.timeout(60_000) : undefined,
  }).catch(failed);
  const json = await res.json().catch((e: unknown) => {
    // The order reached Hyperliquid but the answer was lost: it may have filled.
    if (!reading) throw new Error("Hyperliquid's answer didn't arrive. Check your positions before trying again.");
    return failed(e);
  });
  if (!res.ok) throw new Error(typeof json === "string" ? json : `Hyperliquid ${res.status}`);
  return json as T;
}

export async function perpMarkets(mode: NetworkMode): Promise<PerpMarket[]> {
  const [meta, mids] = await Promise.all([
    post<{ universe: { name: string; szDecimals: number; maxLeverage: number; isDelisted?: boolean }[] }>(mode, "info", { type: "meta" }),
    post<Record<string, string>>(mode, "info", { type: "allMids" }),
  ]);
  return meta.universe
    .map((u, index) => ({ index, name: u.name, szDecimals: u.szDecimals, maxLeverage: u.maxLeverage, mid: mids[u.name] ? Number(mids[u.name]) : undefined, delisted: u.isDelisted }))
    .filter((m) => !m.delisted)
    .map(({ delisted: _d, ...m }) => m);
}

export async function perpAccount(mode: NetworkMode, user: Address): Promise<PerpAccount> {
  const [state, orders] = await Promise.all([
    post<{
      marginSummary: { accountValue: string; totalMarginUsed: string };
      withdrawable: string;
      assetPositions: { position: { coin: string; szi: string; entryPx: string; positionValue: string; unrealizedPnl: string; leverage: { value: number }; liquidationPx: string | null } }[];
    }>(mode, "info", { type: "clearinghouseState", user }),
    post<PerpAccount["openOrders"]>(mode, "info", { type: "openOrders", user }),
  ]);
  return {
    accountValue: Number(state.marginSummary.accountValue),
    withdrawable: Number(state.withdrawable),
    marginUsed: Number(state.marginSummary.totalMarginUsed),
    positions: state.assetPositions.map(({ position: p }) => ({
      coin: p.coin, size: Number(p.szi), entryPx: Number(p.entryPx), positionValue: Number(p.positionValue),
      unrealizedPnl: Number(p.unrealizedPnl), leverage: p.leverage.value, liquidationPx: p.liquidationPx ? Number(p.liquidationPx) : null,
    })),
    openOrders: orders,
  };
}

export interface PerpOrderInput {
  market: PerpMarket;
  side: "long" | "short";
  /** Position size in USD notional. */
  usd: number;
  leverage: number;
  /** Limit price; omit for a market order (IOC at mid ± slippage). */
  limitPx?: number;
  slippage?: number;
  reduceOnly?: boolean;
}

export interface PreparedPerpOrder {
  title: string;
  details: [string, string][];
  actions: unknown[];
}

/** Rough isolated-style liquidation estimate shown before signing (Hyperliquid's own number is authoritative). */
export function estimateLiquidation(side: "long" | "short", entry: number, leverage: number, maxLeverage: number): number {
  const maintenance = 1 / (2 * maxLeverage);
  const move = 1 / leverage - maintenance;
  return side === "long" ? entry * (1 - move) : entry * (1 + move);
}

/** Wallet-side cap so a mistyped number can't open a reckless position. */
export const MAX_WALLET_LEVERAGE = 10;

export function preparePerpOrder(input: PerpOrderInput): PreparedPerpOrder {
  const { market, side, usd, leverage } = input;
  if (!market.mid) throw new Error("No price for this market right now.");
  if (!(usd >= 10)) throw new Error("Hyperliquid's minimum order is $10.");
  const cap = Math.min(market.maxLeverage, MAX_WALLET_LEVERAGE);
  if (!(leverage >= 1 && leverage <= cap)) throw new Error(`Leverage must be 1× to ${cap}×.`);
  const isBuy = side === "long";
  const slippage = input.slippage ?? 0.01;
  const px = input.limitPx ?? market.mid * (isBuy ? 1 + slippage : 1 - slippage);
  const size = Number((usd / market.mid).toFixed(market.szDecimals));
  if (size <= 0) throw new Error("That size rounds to zero for this market.");
  const order = {
    a: market.index, b: isBuy, p: roundPrice(px, market.szDecimals), s: wire(size, market.szDecimals),
    r: input.reduceOnly ?? false, t: { limit: { tif: input.limitPx ? "Gtc" : "Ioc" } },
  };
  const liq = estimateLiquidation(side, market.mid, leverage, market.maxLeverage);
  return {
    title: `${isBuy ? "Long" : "Short"} ${market.name} perp`,
    details: [
      ["Size", `${order.s} ${market.name} (≈ $${usd.toFixed(2)})`],
      ["Leverage", `${leverage}× cross`],
      ["Margin used", `≈ $${(usd / leverage).toFixed(2)} USDC`],
      ["Order", input.limitPx ? `Limit at ${order.p}` : `Market (fills up to ${order.p})`],
      ["Est. liquidation", `≈ ${liq.toPrecision(5)}`],
      ["Venue", "Hyperliquid (fees set by Hyperliquid; Infinitum adds none)"],
      ["Risk", "Leveraged. You can lose all the margin on this position."],
    ],
    actions: [
      { type: "updateLeverage", asset: market.index, isCross: true, leverage },
      { type: "order", orders: [order], grouping: "na" },
    ],
  };
}

export function prepareClose(market: PerpMarket, position: PerpPosition, slippage = 0.01): PreparedPerpOrder {
  if (!market.mid) throw new Error("No price for this market right now.");
  const isBuy = position.size < 0;
  const order = {
    a: market.index, b: isBuy, p: roundPrice(market.mid * (isBuy ? 1 + slippage : 1 - slippage), market.szDecimals),
    s: wire(Math.abs(position.size), market.szDecimals), r: true, t: { limit: { tif: "Ioc" } },
  };
  return {
    title: `Close ${market.name} ${position.size > 0 ? "long" : "short"}`,
    details: [["Size", `${order.s} ${market.name}`], ["Order", `Market, reduce-only (up to ${order.p})`], ["Unrealized PnL", `$${position.unrealizedPnl.toFixed(2)}`]],
    actions: [{ type: "order", orders: [order], grouping: "na" }],
  };
}

export function prepareCancel(market: PerpMarket, oid: number): PreparedPerpOrder {
  return { title: `Cancel ${market.name} order`, details: [["Order id", String(oid)]], actions: [{ type: "cancel", cancels: [{ a: market.index, o: oid }] }] };
}

export async function submit(mode: NetworkMode, account: HDAccount, prepared: PreparedPerpOrder): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const action of prepared.actions) {
    const nonce = Date.now();
    const signature = await signL1Action(account, action, nonce, mode === "mainnet");
    const r = await post<{ status: string; response?: unknown }>(mode, "exchange", { action, nonce, signature, vaultAddress: null });
    if (r.status !== "ok") throw new Error(typeof r.response === "string" ? r.response : "Hyperliquid rejected the order.");
    const statuses = (r.response as { data?: { statuses?: ({ error?: string } | string)[] } })?.data?.statuses ?? [];
    const err = statuses.find((s): s is { error: string } => typeof s === "object" && !!s && "error" in s);
    if (err) throw new Error(err.error);
    results.push(r.response);
  }
  return results;
}
