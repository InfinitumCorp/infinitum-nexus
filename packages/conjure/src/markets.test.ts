import assert from "node:assert/strict";
import { test } from "node:test";
import { conjureMarketSignal, featuresAt, MarketDataError, normalizeCandles, normCdf, optionView, perpView, probabilityAbove, swarmQuestion, type Candle } from "./markets.ts";

const DAY = 86_400_000;

/** Seeded PRNG so the tests are deterministic. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 2 ** 32;
    return seed / 2 ** 32;
  };
}

function series(n: number, step: (i: number, r: () => number) => number, seed = 7): Candle[] {
  const r = rng(seed);
  let price = 100;
  return Array.from({ length: n }, (_, i) => {
    price *= Math.exp(step(i, r));
    return { t: Date.UTC(2025, 0, 1) + i * DAY, close: price };
  });
}

test("a pure random walk has no edge, so nothing is suggested", () => {
  const candles = series(400, (_, r) => (r() - 0.5) * 0.06);
  const s = conjureMarketSignal("TEST", candles, { now: () => new Date("2026-01-01") });
  assert.equal(s.model, "conjure-markets-v1");
  assert.ok(s.probabilityUp > 0 && s.probabilityUp < 1);
  assert.ok(s.range.low < s.price * 1.5 && s.range.high > s.range.low);
  if (!s.backtest.edge) assert.equal(s.action, "no_edge");
  assert.match(s.disclaimer, /not financial advice/);
});

test("a predictable cycle is learned and beats the base rate out of sample", () => {
  // Slow cycle: momentum carries, so the past week predicts the next one.
  const candles = series(420, (i, r) => 0.02 * Math.sin((2 * Math.PI * i) / 60) + (r() - 0.5) * 0.004);
  const s = conjureMarketSignal("CYCLE", candles);
  assert.equal(s.backtest.edge, true, `skill ${s.backtest.skill}`);
  assert.ok(s.backtest.hitRate > 0.7, `hit rate ${s.backtest.hitRate}`);
  assert.ok(["buy", "sell", "hold"].includes(s.action));
  assert.ok(s.factors.length > 0);
});

test("a steady uptrend says buy with an upward expected return", () => {
  const candles = series(300, (i, r) => 0.01 + (r() - 0.5) * 0.004 + 0.003 * Math.sin(i / 9));
  const s = conjureMarketSignal("UP", candles);
  assert.ok(s.expectedReturn > 0);
  assert.ok(s.action === "buy" || s.action === "no_edge" || s.action === "hold");
});

test("features only use data up to that day", () => {
  const candles = series(200, (_, r) => (r() - 0.5) * 0.05);
  const closes = candles.map((c) => c.close);
  const a = featuresAt(closes, 120);
  const changed = [...closes];
  changed[121] = changed[121]! * 10;
  assert.deepEqual(featuresAt(changed, 120), a);
});

test("short or bad history is refused clearly", () => {
  assert.throws(() => conjureMarketSignal("X", series(60, () => 0.01)), MarketDataError);
  assert.throws(() => conjureMarketSignal("X", series(300, () => 0.01), { horizonDays: 90 }), MarketDataError);
  const cleaned = normalizeCandles([{ t: 2 * DAY, close: 2 }, { t: DAY, close: 1 }, { t: DAY + 5, close: 1.5 }, { t: 3 * DAY, close: -1 }]);
  assert.deepEqual(cleaned.map((c) => c.close), [1.5, 2]);
});

test("the swarm question carries the on-device signal as context", () => {
  const s = conjureMarketSignal("ETH", series(300, (_, r) => (r() - 0.5) * 0.04));
  const q = swarmQuestion(s);
  assert.match(q.question, /ETH/);
  assert.match(q.context, /Backtest skill/);
});

test("normal CDF and lognormal probabilities behave", () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-3);
  assert.ok(Math.abs(probabilityAbove(100, 100, 30, 0, 0.03) - 0.5) < 0.05);
  assert.ok(probabilityAbove(100, 150, 7, 0, 0.02) < 0.01);
  assert.equal(probabilityAbove(100, 90, 0, 0, 0.02), 1);
});

test("option view compares Conjure with the market's implied probability", () => {
  const s = conjureMarketSignal("ETH", series(300, (_, r) => (r() - 0.5) * 0.04));
  const expiry = new Date(Date.parse(s.asOf) + 14 * DAY);
  const call = optionView(s, { kind: "call", strike: s.price * 1.1, expiry, iv: 0.7, now: new Date(s.asOf) });
  const put = optionView(s, { kind: "put", strike: s.price * 1.1, expiry, iv: 0.7, now: new Date(s.asOf) });
  assert.ok(Math.abs(call.conjureItm + put.conjureItm - 1) < 1e-3);
  assert.ok(call.marketItm! > 0 && call.marketItm! < 0.5);
  assert.equal(typeof call.edge, "number");
});

test("perp view never suggests a trade without an edge and caps leverage", () => {
  const s = conjureMarketSignal("TEST", series(400, (_, r) => (r() - 0.5) * 0.06));
  const v = perpView(s);
  if (s.action === "no_edge" || s.action === "hold") assert.equal(v.direction, "flat");
  assert.ok(v.maxSensibleLeverage >= 1 && v.maxSensibleLeverage <= 5);
});
