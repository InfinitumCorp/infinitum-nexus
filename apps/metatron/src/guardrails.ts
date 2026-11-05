/**
 * Guardrails every order passes twice: when it is proposed, and again just before it is sent
 * to the broker (prices, cash and the day's P&L may have moved while it waited for approval).
 */
import type { Side } from "./broker.ts";

export interface Policy {
  /** Largest single order, in USD. */
  maxOrderUsd: number;
  /** Most orders per UTC day, across all agents and the person. */
  maxDailyOrders: number;
  /** Agents stop proposing once today's loss passes this (USD, positive number). */
  dailyLossLimitUsd: number;
  /** Symbols agents and the assistant may trade. Empty = any symbol the broker supports. */
  allowedSymbols: string[];
  /** Stops every automated order (agents and the assistant). The person can still trade by hand. */
  killSwitch: boolean;
  /** Minutes an approval stays valid before it expires unexecuted. */
  approvalTtlMinutes: number;
}

export const DEFAULT_POLICY: Policy = {
  maxOrderUsd: 5_000,
  maxDailyOrders: 10,
  dailyLossLimitUsd: 1_500,
  allowedSymbols: ["SPY", "VTI", "QQQ", "EFA", "EEM", "XLK", "XLV", "XLF", "XLE", "XLP", "BTC/USD", "ETH/USD", "SOL/USD"],
  killSwitch: false,
  approvalTtlMinutes: 15,
};

export type Origin = "user" | "agent" | "assistant";

export interface OrderIntent {
  symbol: string;
  side: Side;
  notionalUsd: number;
}

export interface GuardContext {
  ordersToday: number;
  /** Today's P&L in USD (negative = loss). */
  dayPlUsd: number;
  buyingPower: number;
  /** Market value currently held of this symbol, for sells. */
  heldUsd: number;
}

export interface GuardResult {
  ok: boolean;
  reasons: string[];
}

const SYMBOL = /^[A-Z]{1,6}(\/USD)?$/;

export function normalizePolicy(input: Partial<Policy>, base: Policy = DEFAULT_POLICY): Policy {
  const n = (v: unknown, d: number, min: number, max: number) => {
    const x = Number(v);
    return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : d;
  };
  return {
    maxOrderUsd: n(input.maxOrderUsd, base.maxOrderUsd, 1, 1_000_000),
    maxDailyOrders: Math.round(n(input.maxDailyOrders, base.maxDailyOrders, 0, 200)),
    dailyLossLimitUsd: n(input.dailyLossLimitUsd, base.dailyLossLimitUsd, 0, 10_000_000),
    allowedSymbols: Array.isArray(input.allowedSymbols)
      ? [...new Set(input.allowedSymbols.map((s) => String(s).trim().toUpperCase()).filter((s) => SYMBOL.test(s)))]
      : base.allowedSymbols,
    killSwitch: typeof input.killSwitch === "boolean" ? input.killSwitch : base.killSwitch,
    approvalTtlMinutes: n(input.approvalTtlMinutes, base.approvalTtlMinutes, 1, 24 * 60),
  };
}

export function checkOrder(o: OrderIntent, origin: Origin, ctx: GuardContext, p: Policy): GuardResult {
  const reasons: string[] = [];
  const automated = origin !== "user";
  if (!SYMBOL.test(o.symbol)) reasons.push(`"${o.symbol}" isn't a valid symbol`);
  if (o.side !== "buy" && o.side !== "sell") reasons.push("Side must be buy or sell");
  if (!(o.notionalUsd >= 1)) reasons.push("Order must be at least $1");
  if (o.notionalUsd > p.maxOrderUsd) reasons.push(`Order of $${o.notionalUsd.toFixed(2)} is over the $${p.maxOrderUsd} limit`);
  if (ctx.ordersToday >= p.maxDailyOrders) reasons.push(`Daily limit of ${p.maxDailyOrders} orders reached`);
  if (automated && p.killSwitch) reasons.push("The kill switch is on");
  if (automated && p.allowedSymbols.length && !p.allowedSymbols.includes(o.symbol)) reasons.push(`${o.symbol} isn't on your allowed list`);
  if (automated && ctx.dayPlUsd < -p.dailyLossLimitUsd) reasons.push(`Today's loss passed the $${p.dailyLossLimitUsd} limit`);
  if (o.side === "buy" && o.notionalUsd > ctx.buyingPower) reasons.push(`Not enough buying power ($${ctx.buyingPower.toFixed(2)} available)`);
  if (o.side === "sell" && ctx.heldUsd < 1) reasons.push(`You don't hold any ${o.symbol}`);
  return { ok: reasons.length === 0, reasons };
}
