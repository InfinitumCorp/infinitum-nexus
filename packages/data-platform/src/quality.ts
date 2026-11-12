// © Infinitum Corporation®. All rights reserved.
/**
 * "Unit tests for data", after AWS Deequ: declarative checks that run over a dataset and
 * produce metrics plus pass/fail results. The pipeline runs them on every curated rebuild
 * and records the outcome in the catalog.
 */
import type { Row } from "./table.ts";

export type Check =
  | { kind: "completeness"; column: string; min: number }
  | { kind: "uniqueness"; columns: string[] }
  | { kind: "range"; column: string; min?: number; max?: number }
  | { kind: "freshness"; column: string; maxAgeHours: number }
  | { kind: "row_count"; min?: number; max?: number };

export interface CheckResult {
  check: Check;
  ok: boolean;
  metric: number;
  message: string;
}

export interface QualityReport {
  dataset: string;
  rows: number;
  ok: boolean;
  checked_at: string;
  results: CheckResult[];
}

function present(v: unknown): boolean {
  return v !== null && v !== undefined && v !== "";
}

export function runChecks(dataset: string, rows: Row[], checks: Check[], now: Date = new Date()): QualityReport {
  const results: CheckResult[] = [];
  for (const c of checks) {
    switch (c.kind) {
      case "completeness": {
        const metric = rows.length ? rows.filter((r) => present(r[c.column])).length / rows.length : 1;
        results.push({ check: c, ok: metric >= c.min, metric, message: `${c.column} complete ${(metric * 100).toFixed(1)}%` });
        break;
      }
      case "uniqueness": {
        const keys = rows.map((r) => JSON.stringify(c.columns.map((col) => r[col])));
        const dupes = keys.length - new Set(keys).size;
        results.push({ check: c, ok: dupes === 0, metric: dupes, message: `${dupes} duplicate ${c.columns.join("+")}` });
        break;
      }
      case "range": {
        const bad = rows.filter((r) => {
          const v = r[c.column];
          if (typeof v !== "number") return false;
          return (c.min !== undefined && v < c.min) || (c.max !== undefined && v > c.max);
        }).length;
        results.push({ check: c, ok: bad === 0, metric: bad, message: `${bad} ${c.column} values out of range` });
        break;
      }
      case "freshness": {
        let newest = 0;
        for (const r of rows) {
          const t = Date.parse(String(r[c.column] ?? ""));
          if (!Number.isNaN(t) && t > newest) newest = t;
        }
        const ageH = rows.length && newest ? (now.getTime() - newest) / 3_600_000 : 0;
        results.push({ check: c, ok: ageH <= c.maxAgeHours, metric: ageH, message: `newest ${c.column} is ${ageH.toFixed(1)}h old` });
        break;
      }
      case "row_count": {
        const n = rows.length;
        const ok = (c.min === undefined || n >= c.min) && (c.max === undefined || n <= c.max);
        results.push({ check: c, ok, metric: n, message: `${n} rows` });
        break;
      }
    }
  }
  return { dataset, rows: rows.length, ok: results.every((r) => r.ok), checked_at: now.toISOString(), results };
}
