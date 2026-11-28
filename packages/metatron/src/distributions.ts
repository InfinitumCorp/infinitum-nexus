/**
 * Uncertain inputs for METATRON scenarios.
 *
 * A distribution says what a value could be. A rate decision might be
 * `{ kind: "choice", options: [{ value: 5.25, weight: 0.7 }, { value: 5.5, weight: 0.3 }] }`,
 * a supply delay `{ kind: "triangular", min: 0, mode: 2, max: 8 }`.
 */
import type { Rng } from "./rng.ts";

export type Dist =
  | { kind: "fixed"; value: number }
  | { kind: "normal"; mean: number; sd: number; min?: number; max?: number }
  | { kind: "uniform"; min: number; max: number }
  | { kind: "triangular"; min: number; mode: number; max: number }
  | { kind: "lognormal"; median: number; sigma: number }
  | { kind: "bernoulli"; p: number }
  | { kind: "poisson"; lambda: number }
  | { kind: "choice"; options: { value: number; weight: number }[] };

/** A bare number is shorthand for a fixed value. */
export type DistInput = Dist | number;

export function asDist(d: DistInput): Dist {
  return typeof d === "number" ? { kind: "fixed", value: d } : d;
}

const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** Throws a readable error if the distribution is malformed. */
export function checkDist(name: string, input: DistInput): Dist {
  const d = asDist(input);
  const bad = (why: string): never => {
    throw new Error(`variable "${name}": ${why}`);
  };
  if (!d || typeof d !== "object") bad("expected a number or a distribution");
  switch (d.kind) {
    case "fixed":
      if (!finite(d.value)) bad("value must be a number");
      break;
    case "normal":
      if (!finite(d.mean) || !finite(d.sd) || d.sd < 0) bad("normal needs mean and sd ≥ 0");
      if (d.min !== undefined && d.max !== undefined && d.min > d.max) bad("min is above max");
      break;
    case "uniform":
      if (!finite(d.min) || !finite(d.max) || d.min > d.max) bad("uniform needs min ≤ max");
      break;
    case "triangular":
      if (!finite(d.min) || !finite(d.mode) || !finite(d.max) || !(d.min <= d.mode && d.mode <= d.max)) bad("triangular needs min ≤ mode ≤ max");
      break;
    case "lognormal":
      if (!finite(d.median) || d.median <= 0 || !finite(d.sigma) || d.sigma < 0) bad("lognormal needs median > 0 and sigma ≥ 0");
      break;
    case "bernoulli":
      if (!finite(d.p) || d.p < 0 || d.p > 1) bad("bernoulli needs 0 ≤ p ≤ 1");
      break;
    case "poisson":
      if (!finite(d.lambda) || d.lambda < 0 || d.lambda > 1e6) bad("poisson needs 0 ≤ lambda ≤ 1e6");
      break;
    case "choice":
      if (!Array.isArray(d.options) || d.options.length === 0) bad("choice needs options");
      if (d.options.some((o) => !finite(o.value) || !finite(o.weight) || o.weight < 0)) bad("choice options need value and weight ≥ 0");
      if (d.options.reduce((s, o) => s + o.weight, 0) <= 0) bad("choice weights sum to zero");
      break;
    default:
      bad(`unknown kind "${(d as { kind: string }).kind}"`);
  }
  return d;
}

export function sample(d: Dist, r: Rng): number {
  switch (d.kind) {
    case "fixed":
      return d.value;
    case "normal": {
      const x = r.normal(d.mean, d.sd);
      return Math.min(d.max ?? Infinity, Math.max(d.min ?? -Infinity, x));
    }
    case "uniform":
      return r.uniform(d.min, d.max);
    case "triangular": {
      const u = r.next();
      const { min: a, mode: c, max: b } = d;
      if (b === a) return a;
      const f = (c - a) / (b - a);
      return u < f ? a + Math.sqrt(u * (b - a) * (c - a)) : b - Math.sqrt((1 - u) * (b - a) * (b - c));
    }
    case "lognormal":
      return d.median * Math.exp(r.normal(0, d.sigma));
    case "bernoulli":
      return r.bernoulli(d.p) ? 1 : 0;
    case "poisson": {
      if (d.lambda > 50) return Math.max(0, Math.round(r.normal(d.lambda, Math.sqrt(d.lambda))));
      const L = Math.exp(-d.lambda);
      let k = 0;
      let p = 1;
      do {
        k++;
        p *= r.next();
      } while (p > L);
      return k - 1;
    }
    case "choice": {
      const total = d.options.reduce((s, o) => s + o.weight, 0);
      let u = r.next() * total;
      for (const o of d.options) {
        u -= o.weight;
        if (u < 0) return o.value;
      }
      return d.options[d.options.length - 1]!.value;
    }
  }
}

/** True when the distribution can only take one value. */
export function isFixed(d: Dist): boolean {
  switch (d.kind) {
    case "fixed":
      return true;
    case "normal":
      return d.sd === 0;
    case "uniform":
    case "triangular":
      return d.min === d.max;
    case "lognormal":
      return d.sigma === 0;
    case "bernoulli":
      return d.p === 0 || d.p === 1;
    case "poisson":
      return d.lambda === 0;
    case "choice":
      return new Set(d.options.filter((o) => o.weight > 0).map((o) => o.value)).size === 1;
  }
}

/** Linear-interpolated quantile of an already sorted array. */
export function quantileSorted(sorted: ArrayLike<number>, q: number): number {
  const len = sorted.length;
  if (len === 0) return NaN;
  const pos = (len - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}
