/**
 * METATRON evaluation: how good are probability predictions?
 *
 * - Brier score: mean squared error of the probability (0 is perfect, lower is better).
 * - Log loss: penalizes confident mistakes hard (lower is better).
 * - AUC: chance a random win is ranked above a random loss (0.5 is a coin flip).
 * - Brier skill: improvement over always predicting the base rate (> 0 is useful).
 * - Calibration: in each probability bin, the predicted mean against what happened.
 */

export interface Scored {
  probability: number;
  outcome: boolean;
}

export interface CalibrationBin {
  from: number;
  to: number;
  count: number;
  meanPredicted: number;
  observedRate: number;
}

export interface Evaluation {
  n: number;
  baseRate: number;
  brier: number;
  baselineBrier: number;
  brierSkill: number;
  logLoss: number;
  auc: number;
  calibration: CalibrationBin[];
}

const EPS = 1e-12;

export function brier(rows: readonly Scored[]): number {
  if (rows.length === 0) return NaN;
  return rows.reduce((s, r) => s + (r.probability - (r.outcome ? 1 : 0)) ** 2, 0) / rows.length;
}

export function logLoss(rows: readonly Scored[]): number {
  if (rows.length === 0) return NaN;
  return -rows.reduce((s, r) => {
    const p = Math.min(1 - EPS, Math.max(EPS, r.probability));
    return s + (r.outcome ? Math.log(p) : Math.log(1 - p));
  }, 0) / rows.length;
}

/** Rank-based AUC (Mann–Whitney U) with ties counted as half. */
export function auc(rows: readonly Scored[]): number {
  const sorted = [...rows].sort((a, b) => a.probability - b.probability);
  let rankSumPos = 0;
  let pos = 0;
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1]!.probability === sorted[i]!.probability) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) {
      if (sorted[k]!.outcome) {
        rankSumPos += avgRank;
        pos++;
      }
    }
    i = j + 1;
  }
  const neg = sorted.length - pos;
  if (pos === 0 || neg === 0) return NaN;
  return (rankSumPos - (pos * (pos + 1)) / 2) / (pos * neg);
}

export function calibration(rows: readonly Scored[], bins = 5): CalibrationBin[] {
  const out: CalibrationBin[] = [];
  for (let b = 0; b < bins; b++) {
    const from = b / bins;
    const to = (b + 1) / bins;
    const inBin = rows.filter((r) => r.probability >= from && (b === bins - 1 ? r.probability <= to : r.probability < to));
    if (inBin.length === 0) continue;
    out.push({
      from,
      to,
      count: inBin.length,
      meanPredicted: inBin.reduce((s, r) => s + r.probability, 0) / inBin.length,
      observedRate: inBin.filter((r) => r.outcome).length / inBin.length,
    });
  }
  return out;
}

export function evaluate(rows: readonly Scored[], bins = 5): Evaluation {
  if (rows.length === 0) throw new Error("nothing to evaluate");
  const baseRate = rows.filter((r) => r.outcome).length / rows.length;
  const b = brier(rows);
  const baselineBrier = brier(rows.map((r) => ({ probability: baseRate, outcome: r.outcome })));
  return {
    n: rows.length,
    baseRate,
    brier: b,
    baselineBrier,
    brierSkill: baselineBrier === 0 ? 0 : 1 - b / baselineBrier,
    logLoss: logLoss(rows),
    auc: auc(rows),
    calibration: calibration(rows, bins),
  };
}

/** Forecast error metrics for a numeric series. */
export interface ForecastError {
  n: number;
  mae: number;
  rmse: number;
  /** Symmetric MAPE in percent (robust to zeros). */
  smape: number;
}

export function forecastError(actual: readonly number[], predicted: readonly number[]): ForecastError {
  const n = Math.min(actual.length, predicted.length);
  if (n === 0) throw new Error("nothing to compare");
  let abs = 0;
  let sq = 0;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const e = actual[i]! - predicted[i]!;
    abs += Math.abs(e);
    sq += e * e;
    const denom = (Math.abs(actual[i]!) + Math.abs(predicted[i]!)) / 2;
    s += denom === 0 ? 0 : Math.abs(e) / denom;
  }
  return { n, mae: abs / n, rmse: Math.sqrt(sq / n), smape: (s / n) * 100 };
}
