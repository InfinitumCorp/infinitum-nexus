/**
 * METATRON backtests.
 *
 * Win probability: rows are put in time order and the model is trained on
 * the earlier part only, then scored on the later part. This is the
 * honest test for a CRM: next quarter's deals are always scored by a model
 * that has only seen the past.
 *
 * Series forecasts: rolling-origin evaluation. From each starting point the
 * forecaster sees only the history so far and predicts the next `horizon`
 * values, which are compared with what actually came.
 */
import { evaluate, forecastError, type Evaluation, type ForecastError } from "./evaluate.ts";
import { predictWith, train, type TrainOptions, type TrainingRow } from "./learn.ts";
import { predict } from "./predict.ts";

export interface TimedRow extends TrainingRow {
  /** Sortable time, e.g. an ISO date of when the deal closed. */
  t: string;
}

export interface ProbabilityBacktest {
  trainSize: number;
  testSize: number;
  learned: Evaluation;
  default: Evaluation;
  /** Which model scored the lower Brier on the held-out period. */
  better: "learned" | "default";
}

export function backtestProbability(rows: readonly TimedRow[], holdout = 0.3, opts?: TrainOptions): ProbabilityBacktest {
  if (holdout <= 0 || holdout >= 1) throw new Error("holdout must be between 0 and 1");
  const ordered = [...rows].sort((a, b) => a.t.localeCompare(b.t));
  const cut = Math.floor(ordered.length * (1 - holdout));
  const trainRows = ordered.slice(0, cut);
  const testRows = ordered.slice(cut);
  if (trainRows.length < 10 || testRows.length < 5) throw new Error("not enough rows to backtest");
  const model = train(trainRows, opts);
  const learned = evaluate(testRows.map((r) => ({ probability: predictWith(model, r).probability, outcome: r.outcome })));
  const baseline = evaluate(testRows.map((r) => ({ probability: predict(r).probability, outcome: r.outcome })));
  return {
    trainSize: trainRows.length,
    testSize: testRows.length,
    learned,
    default: baseline,
    better: learned.brier <= baseline.brier ? "learned" : "default",
  };
}

export type Forecaster = (history: readonly number[], horizon: number) => number[];

/** Last value repeated: the baseline every forecaster must beat. */
export const naive: Forecaster = (h, horizon) => (h.length ? Array(horizon).fill(h[h.length - 1]) : []);

/** Last change carried forward (what `project()` does). */
export const lastDelta: Forecaster = (h, horizon) => {
  if (h.length < 2) return naive(h, horizon);
  const d = h[h.length - 1]! - h[h.length - 2]!;
  return Array.from({ length: horizon }, (_, i) => h[h.length - 1]! + d * (i + 1));
};

/**
 * Holt's linear trend with damping. alpha smooths the level, beta the
 * trend, phi < 1 flattens the trend over the horizon so long forecasts
 * don't run away.
 */
export function holt(alpha = 0.5, beta = 0.2, phi = 0.9): Forecaster {
  return (h, horizon) => {
    if (h.length < 2) return naive(h, horizon);
    let level = h[0]!;
    let trend = h[1]! - h[0]!;
    for (let i = 1; i < h.length; i++) {
      const prevLevel = level;
      level = alpha * h[i]! + (1 - alpha) * (level + phi * trend);
      trend = beta * (level - prevLevel) + (1 - beta) * phi * trend;
    }
    const out: number[] = [];
    let damp = 0;
    for (let k = 1; k <= horizon; k++) {
      damp += phi ** k;
      out.push(level + damp * trend);
    }
    return out;
  };
}

export function backtestSeries(
  values: readonly number[],
  forecasters: Record<string, Forecaster>,
  opts: { minHistory?: number; horizon?: number } = {},
): Record<string, ForecastError> {
  const minHistory = opts.minHistory ?? 6;
  const horizon = opts.horizon ?? 1;
  if (values.length < minHistory + horizon) throw new Error("series too short to backtest");
  const out: Record<string, ForecastError> = {};
  for (const [name, f] of Object.entries(forecasters)) {
    const actual: number[] = [];
    const predicted: number[] = [];
    for (let origin = minHistory; origin + horizon <= values.length; origin++) {
      const fc = f(values.slice(0, origin), horizon);
      actual.push(...values.slice(origin, origin + horizon));
      predicted.push(...fc);
    }
    out[name] = forecastError(actual, predicted);
  }
  return out;
}
