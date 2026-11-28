// © Infinitum Corporation®. All rights reserved.
/**
 * Differentially private aggregates for analytical releases (the approach of Google's
 * differential-privacy library): bounded contributions per person, Laplace noise scaled to
 * sensitivity / epsilon, and a per-dataset privacy budget that refuses further releases once
 * spent. Small groups are suppressed after noising.
 *
 * Use this for anything leaving the tenant (Exchange samples, public statistics). Internal
 * service operation uses exact numbers under policy instead.
 */
import { randomBytes } from "node:crypto";

/** Uniform (0,1) from the CSPRNG; avoids Math.random for privacy noise. */
function uniform(): number {
  const n = randomBytes(6).readUIntBE(0, 6);
  return (n + 0.5) / 2 ** 48;
}

export function laplace(scale: number): number {
  const u = uniform() - 0.5;
  return -scale * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
}

export class PrivacyBudget {
  private spent = new Map<string, number>();
  readonly total: number;
  constructor(totalEpsilon: number) {
    if (!(totalEpsilon > 0)) throw new Error("budget must be positive");
    this.total = totalEpsilon;
  }
  remaining(dataset: string): number {
    return this.total - (this.spent.get(dataset) ?? 0);
  }
  charge(dataset: string, epsilon: number): void {
    if (!(epsilon > 0)) throw new Error("epsilon must be positive");
    if (epsilon > this.remaining(dataset) + 1e-12) throw new Error(`privacy budget exhausted for ${dataset}`);
    this.spent.set(dataset, (this.spent.get(dataset) ?? 0) + epsilon);
  }
}

export interface DpCountOptions<T> {
  dataset: string;
  budget: PrivacyBudget;
  epsilon: number;
  /** Who contributed the row; used to bound each person's influence. */
  person: (row: T) => string;
  group: (row: T) => string;
  /** Max groups one person may contribute to (default 1). */
  maxGroupsPerPerson?: number;
  /** Noisy counts below this are suppressed (default 10). */
  threshold?: number;
  /** Explicit group list. Without it, only observed groups appear, which itself leaks a little. */
  groups?: string[];
  noise?: (scale: number) => number;
}

/** Noisy count of distinct people per group. */
export function dpCountDistinct<T>(rows: T[], o: DpCountOptions<T>): Map<string, number> {
  const k = o.maxGroupsPerPerson ?? 1;
  o.budget.charge(o.dataset, o.epsilon);
  const perPerson = new Map<string, Set<string>>();
  for (const r of rows) {
    const p = o.person(r);
    let s = perPerson.get(p);
    if (!s) perPerson.set(p, (s = new Set()));
    if (s.size < k) s.add(o.group(r));
  }
  const counts = new Map<string, number>();
  for (const g of o.groups ?? []) counts.set(g, 0);
  for (const s of perPerson.values()) for (const g of s) if (!o.groups || o.groups.includes(g)) counts.set(g, (counts.get(g) ?? 0) + 1);
  const noise = o.noise ?? laplace;
  const scale = k / o.epsilon;
  const out = new Map<string, number>();
  for (const [g, c] of counts) {
    const v = Math.round(c + noise(scale));
    if (v >= (o.threshold ?? 10)) out.set(g, v);
  }
  return out;
}
