/**
 * Conjure™ Markets: predictive signals for buying, selling and trading crypto in $FIRM Wallet™.
 *
 * Runs entirely on the device, with no model calls and no cost: METATRON's learned logistic
 * model scores the chance that price is higher after `horizonDays`, and METATRON's damped Holt
 * trend gives the expected move. Before any buy or sell is suggested, the model is backtested
 * walk-forward (train on the past, score the later period it never saw) against the base rate.
 * If it doesn't beat the base rate, the signal is "no_edge" and nothing is suggested.
 *
 * The optional Conjure swarm (`swarmQuestion`) asks the full agent swarm the same question on
 * the server; it is opt-in because it uses paid model calls.
 *
 * Forecasts are probabilities, not guarantees, and never financial advice. Nothing here trades:
 * the wallet only pre-fills a swap that the person reviews and signs.
 */
import { predictWith, train, type LearnedModel } from "@infinitum/metatron/learn";
import { evaluate } from "@infinitum/metatron/evaluate";
import { holt } from "@infinitum/metatron/backtest";

export interface Candle {
  /** Unix ms at the close. */
  t: number;
  close: number;
}

export type SignalAction = "buy" | "sell" | "hold" | "no_edge";

export interface MarketSignal {
  asset: string;
  model: "conjure-markets-v1";
  horizonDays: number;
  asOf: string;
  price: number;
  /** Chance the price is higher after the horizon, 0..1. */
  probabilityUp: number;
  /** Expected simple return over the horizon (0.04 = +4%). */
  expectedReturn: number;
  /** Daily volatility of log returns over the last 60 days. */
  dailyVol: number;
  /** 80% range for the price at the horizon. */
  range: { low: number; high: number };
  action: SignalAction;
  confidence: "low" | "medium" | "high";
  /** Strongest drivers as odds ratios (>1 pushes up, <1 pushes down). */
  factors: { label: string; effect: number }[];
  backtest: {
    trainSize: number;
    testSize: number;
    brier: number;
    baselineBrier: number;
    /** 1 − brier / baselineBrier. Positive means better than the base rate. */
    skill: number;
    auc: number;
    /** Share of held-out days where the model's call (up / down) was right. */
    hitRate: number;
    edge: boolean;
  };
  reason: string;
  disclaimer: string;
}

export interface SignalOptions {
  horizonDays?: number;
  /** Share of history held out for the backtest. */
  holdout?: number;
  buyAt?: number;
  sellAt?: number;
  /** Minimum backtest skill before any buy or sell is suggested. */
  minSkill?: number;
  now?: () => Date;
}

export const DISCLAIMER =
  "Conjure forecasts are probabilities from past prices, not guarantees and not financial advice. Crypto can lose value quickly. Only you decide and sign a trade.";

const WARMUP = 50;

export class MarketDataError extends Error {}

function logReturn(a: number, b: number): number {
  return Math.log(b / a);
}

function std(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((s, v) => s + v, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1));
}

function rsi(closes: readonly number[], i: number, period = 14): number {
  let gain = 0;
  let loss = 0;
  for (let k = i - period + 1; k <= i; k++) {
    const d = closes[k]! - closes[k - 1]!;
    if (d > 0) gain += d;
    else loss -= d;
  }
  if (gain + loss === 0) return 50;
  return (100 * gain) / (gain + loss);
}

/** Price features known at the close of day `i` (only data up to and including `i`). */
export function featuresAt(closes: readonly number[], i: number): Record<string, number> {
  if (i < WARMUP) throw new MarketDataError(`need ${WARMUP} days of history before day ${i}`);
  const c = closes[i]!;
  const rets: number[] = [];
  for (let k = i - 13; k <= i; k++) rets.push(logReturn(closes[k - 1]!, closes[k]!));
  const sma = (n: number) => closes.slice(i - n + 1, i + 1).reduce((s, v) => s + v, 0) / n;
  const max30 = Math.max(...closes.slice(i - 29, i + 1));
  return {
    "1-day momentum": logReturn(closes[i - 1]!, c),
    "7-day momentum": logReturn(closes[i - 7]!, c),
    "30-day momentum": logReturn(closes[i - 30]!, c),
    "14-day volatility": std(rets),
    "RSI 14": rsi(closes, i),
    "vs 20-day average": c / sma(20) - 1,
    "vs 50-day average": c / sma(50) - 1,
    "30-day drawdown": c / max30 - 1,
  };
}

interface Row {
  i: number;
  features: Record<string, number>;
  outcome: boolean;
}

function labeledRows(closes: readonly number[], horizon: number): Row[] {
  const rows: Row[] = [];
  for (let i = WARMUP; i + horizon < closes.length; i++) {
    rows.push({ i, features: featuresAt(closes, i), outcome: closes[i + horizon]! > closes[i]! });
  }
  return rows;
}

function fit(rows: readonly Row[]): LearnedModel {
  return train(rows.map((r) => ({ subject: String(r.i), features: r.features, outcome: r.outcome })), { l2: 0.05, epochs: 600 });
}

/** Clean, sort and de-duplicate daily candles. */
export function normalizeCandles(candles: readonly Candle[]): Candle[] {
  const byDay = new Map<number, Candle>();
  for (const c of candles) {
    if (!Number.isFinite(c.close) || c.close <= 0 || !Number.isFinite(c.t)) continue;
    byDay.set(Math.floor(c.t / 86_400_000), c);
  }
  return [...byDay.values()].sort((a, b) => a.t - b.t);
}

/**
 * Score one asset. Needs at least ~120 daily closes; a year of history gives a much more
 * honest backtest.
 */
export function conjureMarketSignal(asset: string, candles: readonly Candle[], opts: SignalOptions = {}): MarketSignal {
  const horizon = opts.horizonDays ?? 7;
  const holdout = opts.holdout ?? 0.3;
  const buyAt = opts.buyAt ?? 0.58;
  const sellAt = opts.sellAt ?? 0.42;
  const minSkill = opts.minSkill ?? 0.01;
  const now = opts.now ?? (() => new Date());
  if (!(horizon >= 1 && horizon <= 30)) throw new MarketDataError("horizonDays must be 1 to 30");

  const series = normalizeCandles(candles);
  const closes = series.map((c) => c.close);
  if (closes.length < WARMUP + horizon + 60) throw new MarketDataError(`not enough price history for ${asset} (have ${closes.length} days)`);

  const rows = labeledRows(closes, horizon);
  // Walk-forward backtest. Purge `horizon` rows between train and test so no training label
  // looks into the test period.
  const cut = Math.floor(rows.length * (1 - holdout));
  const trainRows = rows.slice(0, Math.max(0, cut - horizon));
  const testRows = rows.slice(cut);
  const btModel = fit(trainRows);
  const trainRate = trainRows.filter((r) => r.outcome).length / trainRows.length;
  const scored = testRows.map((r) => ({ probability: predictWith(btModel, { subject: "", features: r.features }).probability, outcome: r.outcome }));
  const ev = evaluate(scored);
  const baselineBrier = testRows.reduce((s, r) => s + (trainRate - (r.outcome ? 1 : 0)) ** 2, 0) / testRows.length;
  const skill = baselineBrier > 0 ? 1 - ev.brier / baselineBrier : 0;
  const hitRate = scored.filter((s) => (s.probability >= 0.5) === s.outcome).length / scored.length;
  const edge = skill >= minSkill && testRows.length >= 30;

  // Final model on everything labeled, scored on today.
  const model = fit(rows);
  const last = closes.length - 1;
  const today = predictWith(model, { subject: asset, features: featuresAt(closes, last) });
  const p = today.probability;

  const logs = closes.map((c) => Math.log(c));
  const trendLog = holt(0.4, 0.1, 0.9)(logs.slice(-120), horizon).at(-1)!;
  const expectedReturn = Math.exp(trendLog - logs[last]!) - 1;
  const dailyVol = std(logs.slice(-61).map((v, k, a) => (k === 0 ? 0 : v - a[k - 1]!)).slice(1));
  const spread = 1.2816 * dailyVol * Math.sqrt(horizon);
  const price = closes[last]!;
  const center = Math.log(price) + Math.log(1 + expectedReturn);

  let action: SignalAction;
  let reason: string;
  if (!edge) {
    action = "no_edge";
    reason = `The model didn't beat the base rate on the last ${testRows.length} days it never saw (skill ${(skill * 100).toFixed(1)}%), so Conjure isn't suggesting a trade.`;
  } else if (p >= buyAt && expectedReturn > 0) {
    action = "buy";
    reason = `${Math.round(p * 100)}% chance ${asset} is higher in ${horizon} days, and the trend points up.`;
  } else if (p <= sellAt && expectedReturn < 0) {
    action = "sell";
    reason = `${Math.round((1 - p) * 100)}% chance ${asset} is lower in ${horizon} days, and the trend points down.`;
  } else {
    action = "hold";
    reason = `Signals are mixed (${Math.round(p * 100)}% up, trend ${expectedReturn >= 0 ? "+" : ""}${(expectedReturn * 100).toFixed(1)}%).`;
  }
  const strength = Math.abs(p - 0.5);
  const confidence = !edge || strength < 0.08 ? "low" : strength < 0.15 || skill < 0.05 ? "medium" : "high";

  return {
    asset,
    model: "conjure-markets-v1",
    horizonDays: horizon,
    asOf: now().toISOString(),
    price,
    probabilityUp: Math.round(p * 1000) / 1000,
    expectedReturn: Math.round(expectedReturn * 10000) / 10000,
    dailyVol: round4(dailyVol),
    range: { low: Math.exp(center - spread), high: Math.exp(center + spread) },
    action,
    confidence,
    factors: today.factors.slice(0, 4),
    backtest: {
      trainSize: trainRows.length,
      testSize: testRows.length,
      brier: round4(ev.brier),
      baselineBrier: round4(baselineBrier),
      skill: round4(skill),
      auc: round4(ev.auc),
      hitRate: round4(hitRate),
      edge,
    },
    reason,
    disclaimer: DISCLAIMER,
  };
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

/** Question and context for the optional @conjure swarm, seeded with the on-device signal. */
export function swarmQuestion(signal: MarketSignal): { question: string; context: string } {
  return {
    question: `Will ${signal.asset} trade above ${signal.price.toPrecision(6)} USD ${signal.horizonDays} days from ${signal.asOf.slice(0, 10)}?`,
    context: [
      `On-device Conjure Markets model: ${Math.round(signal.probabilityUp * 100)}% up, expected ${(signal.expectedReturn * 100).toFixed(1)}%,`,
      `80% range ${signal.range.low.toPrecision(5)}–${signal.range.high.toPrecision(5)} USD.`,
      `Backtest skill ${(signal.backtest.skill * 100).toFixed(1)}% over ${signal.backtest.testSize} held-out days.`,
      `Top factors: ${signal.factors.map((f) => `${f.label} ×${f.effect}`).join(", ") || "none"}.`,
    ].join(" "),
  };
}

/* ---------------- Options and perps ---------------- */

/** Standard normal CDF (Abramowitz–Stegun 7.1.26, error < 1.5e-7). */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/**
 * Chance the price ends above `strike` after `days`, for a lognormal move with the given daily
 * drift (log) and daily volatility.
 */
export function probabilityAbove(spot: number, strike: number, days: number, dailyDrift: number, dailyVol: number): number {
  if (days <= 0) return spot > strike ? 1 : 0;
  const sd = Math.max(1e-9, dailyVol * Math.sqrt(days));
  const mean = Math.log(spot) + (dailyDrift - (dailyVol * dailyVol) / 2) * days;
  return 1 - normCdf((Math.log(strike) - mean) / sd);
}

export interface OptionView {
  kind: "call" | "put";
  strike: number;
  days: number;
  /** Conjure's chance this option finishes in the money. */
  conjureItm: number;
  /** The market's risk-neutral chance (N(d2) from implied volatility), when IV is known. */
  marketItm?: number;
  /** conjureItm − marketItm: positive means Conjure rates it more likely than the market does. */
  edge?: number;
  note: string;
}

/**
 * Compare Conjure's view with the option market. Drift comes from the on-device signal only when
 * the backtest showed an edge; otherwise Conjure assumes no drift and just uses realized volatility.
 */
export function optionView(signal: MarketSignal, o: { kind: "call" | "put"; strike: number; expiry: Date; spot?: number; iv?: number; now?: Date }): OptionView {
  const now = o.now ?? new Date();
  const days = Math.max(0, (o.expiry.getTime() - now.getTime()) / 86_400_000);
  const spot = o.spot ?? signal.price;
  const drift = signal.backtest.edge ? Math.log(1 + signal.expectedReturn) / signal.horizonDays : 0;
  const above = probabilityAbove(spot, o.strike, days, drift, signal.dailyVol);
  const conjureItm = o.kind === "call" ? above : 1 - above;
  let marketItm: number | undefined;
  if (o.iv && o.iv > 0 && days > 0) {
    const sigma = o.iv * Math.sqrt(days / 365);
    const d2 = (Math.log(spot / o.strike) - (sigma * sigma) / 2) / sigma;
    marketItm = o.kind === "call" ? normCdf(d2) : normCdf(-d2);
  }
  const edge = marketItm === undefined ? undefined : conjureItm - marketItm;
  const note = !signal.backtest.edge
    ? "Conjure has no proven edge on direction here, so this uses recent volatility only."
    : edge === undefined
      ? "No implied volatility from the market to compare with."
      : Math.abs(edge) < 0.05
        ? "Conjure and the market roughly agree."
        : edge > 0
          ? "Conjure rates this more likely to finish in the money than the market does."
          : "Conjure rates this less likely to finish in the money than the market does.";
  return { kind: o.kind, strike: o.strike, days: Math.round(days * 10) / 10, conjureItm: round4(conjureItm), marketItm: marketItm === undefined ? undefined : round4(marketItm), edge: edge === undefined ? undefined : round4(edge), note };
}

export interface PerpView {
  direction: "long" | "short" | "flat";
  /**
   * Highest leverage at which a 2.5σ move over the horizon stays inside the margin. A ceiling,
   * not a suggestion to use it.
   */
  maxSensibleLeverage: number;
  reason: string;
}

export function perpView(signal: MarketSignal): PerpView {
  const move = 2.5 * signal.dailyVol * Math.sqrt(signal.horizonDays);
  const maxSensibleLeverage = Math.max(1, Math.min(5, Math.floor(1 / Math.max(move, 1e-6))));
  if (signal.action === "buy") return { direction: "long", maxSensibleLeverage, reason: signal.reason };
  if (signal.action === "sell") return { direction: "short", maxSensibleLeverage, reason: signal.reason };
  return { direction: "flat", maxSensibleLeverage, reason: signal.reason };
}
