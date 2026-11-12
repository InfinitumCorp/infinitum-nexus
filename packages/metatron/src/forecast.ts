/**
 * METATRON forecasts.
 *
 * `project` is the original simple linear projection (kept for callers).
 *
 * `forecast` is the full version: it tries several forecasters on the
 * series' own history (rolling origin: each one only ever sees the past),
 * keeps the one with the lowest error, and puts a range around every
 * forecast step taken from how wrong that forecaster actually was at the
 * same distance ahead. A range is an honest "this is how far off we tend
 * to be", not a guarantee.
 */
import type { Series } from "./analytics.ts";
import { holt, lastDelta, naive, type Forecaster } from "./backtest.ts";
import { forecastError, type ForecastError } from "./evaluate.ts";
import { quantileSorted } from "./distributions.ts";

export function project(series: Series, periods: number): number[] {
  if (series.points.length < 2) return [];
  const last = series.points[series.points.length - 1].v;
  const prev = series.points[series.points.length - 2].v;
  const delta = last - prev;
  const out: number[] = [];
  for (let i = 1; i <= periods; i++) out.push(last + delta * i);
  return out;
}

/** Average change over the whole history, carried forward. Steadier than `lastDelta`. */
export const drift: Forecaster = (h, horizon) => {
  if (h.length < 2) return naive(h, horizon);
  const d = (h[h.length - 1]! - h[0]!) / (h.length - 1);
  return Array.from({ length: horizon }, (_, i) => h[h.length - 1]! + d * (i + 1));
};

/** Same value as one season ago (e.g. period 7 for daily data with a weekly pattern). */
export function seasonalNaive(period: number): Forecaster {
  return (h, horizon) => {
    if (h.length < period) return naive(h, horizon);
    return Array.from({ length: horizon }, (_, i) => h[h.length - period + (i % period)]!);
  };
}

/**
 * Additive Holt-Winters: level + damped trend + a repeating seasonal pattern.
 * Needs at least two full seasons.
 */
export function holtWinters(period: number, alpha = 0.4, beta = 0.1, gamma = 0.3, phi = 0.95): Forecaster {
  return (h, horizon) => {
    if (h.length < 2 * period) return seasonalNaive(period)(h, horizon);
    const m1 = avg(h.slice(0, period));
    const m2 = avg(h.slice(period, 2 * period));
    let level = m1;
    let trend = (m2 - m1) / period;
    const season = h.slice(0, period).map((v) => v - m1);
    for (let i = period; i < h.length; i++) {
      const s = season[i % period]!;
      const prevLevel = level;
      level = alpha * (h[i]! - s) + (1 - alpha) * (level + phi * trend);
      trend = beta * (level - prevLevel) + (1 - beta) * phi * trend;
      season[i % period] = gamma * (h[i]! - level) + (1 - gamma) * s;
    }
    const out: number[] = [];
    let damp = 0;
    for (let k = 1; k <= horizon; k++) {
      damp += phi ** k;
      out.push(level + damp * trend + season[(h.length + k - 1) % period]!);
    }
    return out;
  };
}

const avg = (xs: readonly number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;

export interface ForecastOptions {
  /** Width of the range, e.g. 0.8 for an 80% range. */
  level?: number;
  /** Season length, if the data repeats (7 for days in a week, 12 for months in a year). */
  period?: number;
  /** Shortest history a forecaster is judged from. */
  minHistory?: number;
}

export interface ForecastResult {
  model: string;
  horizon: number;
  level: number;
  point: number[];
  lower: number[];
  upper: number[];
  /** Rolling-origin error of the chosen model (absent when history was too short to test). */
  error?: ForecastError;
  /** Every forecaster tried, best first. */
  candidates: { model: string; mae: number }[];
  /** How the ranges were made. */
  intervals: "empirical" | "approximate";
}

export function candidates(period?: number): Record<string, Forecaster> {
  const c: Record<string, Forecaster> = {
    naive,
    "last-delta": lastDelta,
    drift,
    "holt": holt(0.5, 0.2, 0.9),
    "holt-smooth": holt(0.3, 0.1, 0.9),
    "holt-fast": holt(0.8, 0.3, 0.95),
  };
  if (period && period >= 2) {
    c[`seasonal-naive-${period}`] = seasonalNaive(period);
    c[`holt-winters-${period}`] = holtWinters(period);
  }
  return c;
}

/** Pick the forecaster that has done best on this series, and forecast with ranges. */
export function forecast(values: readonly number[], horizon: number, opts: ForecastOptions = {}): ForecastResult {
  const level = opts.level ?? 0.8;
  if (!(level > 0 && level < 1)) throw new Error("level must be between 0 and 1");
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > 1000) throw new Error("horizon must be from 1 to 1000");
  if (values.length === 0) throw new Error("no history to forecast from");
  if (values.some((v) => !Number.isFinite(v))) throw new Error("history has a missing or non-numeric value");
  if (opts.period !== undefined && (!Number.isInteger(opts.period) || opts.period < 2 || opts.period > 366)) throw new Error("period must be from 2 to 366");
  const period = opts.period && values.length >= 2 * opts.period ? opts.period : undefined;
  const pool = candidates(period);
  const minHistory = Math.max(opts.minHistory ?? 4, period ?? 0, 2);
  const lo = (1 - level) / 2;
  const hi = 1 - lo;

  // Rolling origin: errors[model][h] = list of (actual - predicted) at distance h + 1.
  const origins: number[] = [];
  for (let o = minHistory; o < values.length; o++) origins.push(o);
  const tested = origins.length >= 3;

  if (!tested) {
    const model = values.length >= 2 ? "last-delta" : "naive";
    const point = pool[model]!(values, horizon);
    const steps = values.slice(1).map((v, i) => v - values[i]!);
    const sd = steps.length >= 2 ? Math.sqrt(steps.reduce((s, d) => s + (d - avg(steps)) ** 2, 0) / (steps.length - 1)) : Math.abs(values[0]!) * 0.1;
    const z = normalQuantile(hi);
    return {
      model,
      horizon,
      level,
      point,
      lower: point.map((p, k) => p - z * sd * Math.sqrt(k + 1)),
      upper: point.map((p, k) => p + z * sd * Math.sqrt(k + 1)),
      candidates: [],
      intervals: "approximate",
    };
  }

  const scored = Object.entries(pool).map(([model, f]) => {
    const errs: number[][] = Array.from({ length: horizon }, () => []);
    const actual: number[] = [];
    const predicted: number[] = [];
    for (const o of origins) {
      const fc = f(values.slice(0, o), Math.min(horizon, values.length - o));
      fc.forEach((p, k) => {
        const a = values[o + k]!;
        errs[k]!.push(a - p);
        actual.push(a);
        predicted.push(p);
      });
    }
    return { model, f, errs, error: forecastError(actual, predicted) };
  });
  scored.sort((a, b) => a.error.mae - b.error.mae || a.model.localeCompare(b.model));
  const best = scored[0]!;
  const point = best.f(values, horizon);

  // Errors further out than history allows: widen the last known spread by √h.
  const oneStep = best.errs[0]!;
  const rmse1 = Math.sqrt(oneStep.reduce((s, e) => s + e * e, 0) / oneStep.length);
  const z = normalQuantile(hi);
  let empirical = true;
  const lower: number[] = [];
  const upper: number[] = [];
  for (let k = 0; k < horizon; k++) {
    const e = best.errs[k]!;
    if (e.length >= 5) {
      const sorted = [...e].sort((a, b) => a - b);
      lower.push(point[k]! + Math.min(0, quantileSorted(sorted, lo)));
      upper.push(point[k]! + Math.max(0, quantileSorted(sorted, hi)));
    } else {
      empirical = false;
      lower.push(point[k]! - z * rmse1 * Math.sqrt(k + 1));
      upper.push(point[k]! + z * rmse1 * Math.sqrt(k + 1));
    }
  }
  // Ranges never narrow with distance.
  for (let k = 1; k < horizon; k++) {
    const wPrev = upper[k - 1]! - point[k - 1]!;
    const lPrev = point[k - 1]! - lower[k - 1]!;
    if (upper[k]! - point[k]! < wPrev) upper[k] = point[k]! + wPrev;
    if (point[k]! - lower[k]! < lPrev) lower[k] = point[k]! - lPrev;
  }

  return {
    model: best.model,
    horizon,
    level,
    point,
    lower,
    upper,
    error: best.error,
    candidates: scored.map((s) => ({ model: s.model, mae: s.error.mae })),
    intervals: empirical ? "empirical" : "approximate",
  };
}

/** Inverse standard normal CDF (Acklam's approximation, |error| < 1.2e-9). */
export function normalQuantile(p: number): number {
  if (p <= 0 || p >= 1) throw new Error("p must be between 0 and 1");
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - pl) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}
