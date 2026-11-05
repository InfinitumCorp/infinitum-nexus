/**
 * Trading agents. Each one is a pure planner: given holdings, cash and market data it returns
 * the orders it would like to place. It never places them; the service routes every proposal
 * through guardrails and the approval queue.
 */
import type { BrokerPosition } from "./broker.ts";
import type { OrderIntent } from "./guardrails.ts";

export type AgentKind = "rebalance" | "momentum" | "dca";

export interface AgentConfig {
  id: string;
  name: string;
  kind: AgentKind;
  enabled: boolean;
  /** Which broker connection it trades: "paper" or "broker". */
  account: "paper" | "broker";
  /** Paper agents may place paper trades without asking. Real accounts always ask. */
  autoPaper: boolean;
  /** rebalance: symbol -> weight (sums to 1). */
  targets?: Record<string, number>;
  /** momentum: the universe and how many to hold. */
  universe?: string[];
  holdCount?: number;
  /** dca: what and how much per run. */
  symbol?: string;
  amountUsd?: number;
  /** Ignore drifts smaller than this share of the portfolio (default 2%). */
  bandPct?: number;
}

export interface Plan {
  orders: OrderIntent[];
  note: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function planRebalance(a: AgentConfig, positions: BrokerPosition[], cash: number): Plan {
  const targets = a.targets ?? {};
  const weights = Object.values(targets).reduce((s, w) => s + w, 0);
  if (!(weights > 0)) return { orders: [], note: "No target mix set." };
  const held = new Map(positions.map((p) => [p.symbol, p.marketValue]));
  const total = cash + positions.reduce((s, p) => s + p.marketValue, 0);
  const band = total * ((a.bandPct ?? 2) / 100);
  const invest = total * 0.98;
  const sells: OrderIntent[] = [], buys: OrderIntent[] = [];
  for (const [sym, w] of Object.entries(targets)) {
    const diff = invest * (w / weights) - (held.get(sym) ?? 0);
    if (diff > band) buys.push({ symbol: sym, side: "buy", notionalUsd: r2(diff) });
    else if (diff < -band) sells.push({ symbol: sym, side: "sell", notionalUsd: r2(-diff) });
  }
  for (const p of positions) if (!(p.symbol in targets) && p.marketValue > band) sells.push({ symbol: p.symbol, side: "sell", notionalUsd: r2(p.marketValue) });
  const mix = Object.entries(targets).map(([s, w]) => `${s} ${Math.round((w / weights) * 100)}%`).join(", ");
  return { orders: [...sells, ...buys], note: `Target mix ${mix}.` };
}

export function planMomentum(a: AgentConfig, positions: BrokerPosition[], cash: number, returns: Record<string, number>): Plan {
  const universe = (a.universe ?? []).filter((s) => Number.isFinite(returns[s]));
  if (!universe.length) return { orders: [], note: "No recent returns available for the universe." };
  const n = Math.max(1, Math.min(a.holdCount ?? 2, universe.length));
  const top = [...universe].sort((x, y) => returns[y] - returns[x]).slice(0, n);
  const held = new Map(positions.map((p) => [p.symbol, p.marketValue]));
  const total = cash + positions.reduce((s, p) => s + p.marketValue, 0);
  const band = total * ((a.bandPct ?? 2) / 100);
  const each = (total * 0.9) / n;
  const sells: OrderIntent[] = [], buys: OrderIntent[] = [];
  for (const s of universe) if (!top.includes(s) && (held.get(s) ?? 0) > 1) sells.push({ symbol: s, side: "sell", notionalUsd: r2(held.get(s)!) });
  for (const s of top) {
    const diff = each - (held.get(s) ?? 0);
    if (diff > band) buys.push({ symbol: s, side: "buy", notionalUsd: r2(diff) });
    else if (diff < -band) sells.push({ symbol: s, side: "sell", notionalUsd: r2(-diff) });
  }
  return { orders: [...sells, ...buys], note: `Strongest over the past month: ${top.map((s) => `${s} ${returns[s] >= 0 ? "+" : ""}${returns[s].toFixed(1)}%`).join(", ")}.` };
}

export function planDca(a: AgentConfig): Plan {
  if (!a.symbol || !(Number(a.amountUsd) > 0)) return { orders: [], note: "No symbol or amount set." };
  return { orders: [{ symbol: a.symbol, side: "buy", notionalUsd: r2(Number(a.amountUsd)) }], note: `Scheduled buy of $${Number(a.amountUsd).toFixed(2)} ${a.symbol}.` };
}

export const DEFAULT_AGENTS: AgentConfig[] = [
  { id: "rebalancer", name: "Rebalancer", kind: "rebalance", enabled: true, account: "broker", autoPaper: false, targets: { SPY: 0.6, EFA: 0.25, "BTC/USD": 0.15 } },
  { id: "momentum", name: "Sector momentum", kind: "momentum", enabled: true, account: "paper", autoPaper: true, universe: ["XLK", "XLV", "XLF", "XLE", "XLP"], holdCount: 2 },
  { id: "dca", name: "Bitcoin DCA", kind: "dca", enabled: false, account: "broker", autoPaper: false, symbol: "BTC/USD", amountUsd: 250 },
];
