import { test } from "node:test";
import assert from "node:assert/strict";
import { backtestProbability, backtestSeries, holt, lastDelta, naive, type TimedRow } from "./backtest.ts";
import { predictWith, train } from "./learn.ts";

// Deterministic pseudo-random generator so tests never flake.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const STAGES = ["lead", "qualified", "discovery", "proposal", "negotiation"];

/** Synthetic CRM history where "industry=defense" wins far more often than the default model knows. */
function history(n: number): TimedRow[] {
  const r = rng(42);
  const rows: TimedRow[] = [];
  for (let i = 0; i < n; i++) {
    const stage = STAGES[Math.floor(r() * STAGES.length)]!;
    const industry = r() < 0.5 ? "defense" : "retail";
    const touches = Math.floor(r() * 10);
    const z = -2 + STAGES.indexOf(stage) * 0.6 + (industry === "defense" ? 1.5 : -0.5) + touches * 0.1;
    const outcome = r() < 1 / (1 + Math.exp(-z));
    rows.push({ subject: `deal-${i}`, t: `2026-${String(1 + (i % 12)).padStart(2, "0")}-${String(1 + Math.floor(i / 12)).padStart(2, "0")}`, features: { stage, industry, touches }, outcome });
  }
  return rows;
}

test("learned model ranks deals and explains itself", () => {
  const model = train(history(300));
  const hi = predictWith(model, { subject: "a", features: { stage: "negotiation", industry: "defense", touches: 8 } });
  const lo = predictWith(model, { subject: "b", features: { stage: "lead", industry: "retail", touches: 0 } });
  assert.ok(hi.probability > lo.probability + 0.4, `${hi.probability} vs ${lo.probability}`);
  assert.equal(hi.model, "metatron-logistic-v1");
  assert.ok(hi.factors.some((f) => f.label === "Industry: defense" && f.effect > 1));
});

test("train rejects features with mixed types", () => {
  assert.throws(() => train([
    { subject: "a", features: { x: 1 }, outcome: true },
    { subject: "b", features: { x: "1" }, outcome: false },
  ]), /mixed types/);
});

test("backtest: learned model beats the default on data with a signal it does not know", () => {
  const bt = backtestProbability(history(400), 0.3);
  assert.equal(bt.trainSize + bt.testSize, 400);
  assert.equal(bt.better, "learned");
  assert.ok(bt.learned.auc > bt.default.auc);
  assert.ok(bt.learned.brierSkill > 0);
});

test("backtest refuses tiny datasets and bad holdouts", () => {
  assert.throws(() => backtestProbability(history(8)), /not enough rows/);
  assert.throws(() => backtestProbability(history(100), 1), /holdout/);
});

test("forecasters", () => {
  assert.deepEqual(naive([1, 2, 3], 2), [3, 3]);
  assert.deepEqual(lastDelta([1, 2, 4], 2), [6, 8]);
  const h = holt(0.8, 0.5, 1)([10, 20, 30, 40, 50], 1);
  assert.ok(Math.abs(h[0]! - 60) < 1, `holt ${h[0]}`);
});

test("series backtest: trend-aware forecasters beat naive on a noisy trend", () => {
  const r = rng(7);
  const values = Array.from({ length: 36 }, (_, i) => 100 + 5 * i + (r() - 0.5) * 30);
  const res = backtestSeries(values, { naive, lastDelta, holt: holt() }, { horizon: 3 });
  assert.ok(res.holt!.mae < res.naive!.mae);
  assert.ok(res.holt!.mae < res.lastDelta!.mae, `holt ${res.holt!.mae} lastDelta ${res.lastDelta!.mae}`);
});

test("numeric features far outside training are clamped", () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ subject: `s${i}`, features: { amount: 100 + (i % 10), hot: i % 2 === 0 }, outcome: i % 2 === 0 }));
  const model = train(rows);
  const huge = predictWith(model, { subject: "x", features: { amount: 1e9, hot: false } });
  const edge = predictWith(model, { subject: "x", features: { amount: 100 + 9 + 3 * 3, hot: false } });
  assert.ok(Math.abs(huge.probability - edge.probability) < 0.05, `${huge.probability} vs ${edge.probability}`);
});
