/**
 * METATRON learned scorer: L2-regularized logistic regression.
 *
 * Still explainable: each factor is reported as an odds ratio
 * (e.g. "Stage: negotiation ×3.2"), the same shape as the default model's
 * factors, so Spectre can show either. Numeric features are standardized,
 * booleans become 0/1, and strings are one-hot encoded against the values
 * seen in training.
 */
import type { Prediction, PredictionInput } from "./predict.ts";

export interface TrainingRow extends PredictionInput {
  outcome: boolean;
}

export interface TrainOptions {
  /** L2 penalty on weights (not the intercept). */
  l2?: number;
  learningRate?: number;
  epochs?: number;
}

interface Column {
  key: string;
  feature: string;
  kind: "number" | "boolean" | "category";
  value?: string;
  mean?: number;
  std?: number;
}

export interface LearnedModel {
  model: "metatron-logistic-v1";
  intercept: number;
  columns: (Column & { weight: number })[];
  trainedOn: number;
}

function columnsFor(rows: readonly PredictionInput[]): Column[] {
  const kinds = new Map<string, Set<string>>();
  const categories = new Map<string, Set<string>>();
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.features)) {
      if (!kinds.has(k)) kinds.set(k, new Set());
      kinds.get(k)!.add(typeof v);
      if (typeof v === "string") {
        if (!categories.has(k)) categories.set(k, new Set());
        categories.get(k)!.add(v);
      }
    }
  }
  const cols: Column[] = [];
  for (const [feature, ks] of [...kinds.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (ks.size !== 1) throw new Error(`feature "${feature}" has mixed types`);
    const kind = [...ks][0];
    if (kind === "number") {
      const vals = rows.map((r) => r.features[feature]).filter((v): v is number => typeof v === "number");
      const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
      const std = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length) || 1;
      cols.push({ key: feature, feature, kind: "number", mean, std });
    } else if (kind === "boolean") {
      cols.push({ key: feature, feature, kind: "boolean" });
    } else {
      for (const value of [...categories.get(feature)!].sort()) {
        cols.push({ key: `${feature}=${value}`, feature, kind: "category", value });
      }
    }
  }
  return cols;
}

function encode(cols: readonly Column[], f: PredictionInput["features"]): number[] {
  return cols.map((c) => {
    const v = f[c.feature];
    if (c.kind === "number") return typeof v === "number" ? (v - c.mean!) / c.std! : 0;
    if (c.kind === "boolean") return v === true ? 1 : 0;
    return v === c.value ? 1 : 0;
  });
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

export function train(rows: readonly TrainingRow[], opts: TrainOptions = {}): LearnedModel {
  if (rows.length === 0) throw new Error("no training rows");
  const l2 = opts.l2 ?? 0.01;
  const lr = opts.learningRate ?? 0.5;
  const epochs = opts.epochs ?? 2000;
  const cols = columnsFor(rows);
  const X = rows.map((r) => encode(cols, r.features));
  const y = rows.map((r) => (r.outcome ? 1 : 0));
  const n = rows.length;
  const w = cols.map(() => 0);
  const rate = y.reduce((s: number, v) => s + v, 0) / n;
  let b = Math.log(Math.max(1e-6, rate) / Math.max(1e-6, 1 - rate));

  for (let e = 0; e < epochs; e++) {
    const gw = w.map((wi) => l2 * wi);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      const xi = X[i]!;
      const err = sigmoid(b + xi.reduce((s, v, j) => s + v * w[j]!, 0)) - y[i]!;
      gb += err / n;
      for (let j = 0; j < xi.length; j++) gw[j]! += (err * xi[j]!) / n;
    }
    b -= lr * gb;
    for (let j = 0; j < w.length; j++) w[j]! -= lr * gw[j]!;
  }

  return {
    model: "metatron-logistic-v1",
    intercept: b,
    columns: cols.map((c, j) => ({ ...c, weight: w[j]! })),
    trainedOn: n,
  };
}

export function predictWith(model: LearnedModel, input: PredictionInput): Prediction {
  const x = encode(model.columns, input.features);
  let z = model.intercept;
  const factors: Prediction["factors"] = [];
  model.columns.forEach((c, j) => {
    const contribution = c.weight * x[j]!;
    z += contribution;
    if (x[j] !== 0 && Math.abs(contribution) > 1e-3) {
      const label = c.kind === "category" ? `${capitalize(c.feature)}: ${c.value}` : capitalize(c.feature);
      factors.push({ label, effect: Math.round(Math.exp(contribution) * 100) / 100 });
    }
  });
  factors.sort((a, b) => Math.abs(Math.log(b.effect)) - Math.abs(Math.log(a.effect)));
  return { probability: Math.min(0.99, Math.max(0.01, sigmoid(z))), factors, model: model.model };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
