/**
 * METATRON¹⁰⁰ for Spectre: what the pipeline will book, and what changed.
 *
 * - `pipelineOutlook`: a Monte Carlo over open deals expected to close in
 *   the horizon. Each deal closes with its METATRON win probability, so the
 *   result is a range ("$410k–$690k, most likely $540k"), the chance of
 *   hitting a target, and the deals that matter most. A "what if" moves a
 *   stage's win rate and is run on the same draws, so the difference is the
 *   change alone.
 * - `weeklySeries`: the workspace's activity as weekly series (won value,
 *   new deals, activities, inbound replies) for forecasts and the digest.
 */
import { createRng } from "@infinitum/metatron";
import type { Score } from "./intelligence.ts";
import { OPEN_STAGES, type Activity, type Deal, type Stage } from "./model.ts";

const DAY = 86_400_000;

export interface OutlookOptions {
  horizonDays?: number;
  /** Booking target, in the deals' currency. */
  target?: number;
  runs?: number;
  seed?: number;
  /** Percentage points added to the win probability of deals in one stage (e.g. +10). */
  whatIf?: { stage: Stage; winRateChange: number };
}

export interface CurrencyOutlook {
  currency: string;
  deals: number;
  pipeline: number;
  expected: number;
  p10: number;
  p50: number;
  p90: number;
  /** Chance of booking at least the target (absent without a target). */
  probTarget?: number;
  /** Deals that move the answer most: amount × probability, highest first. */
  drivers: { dealId: string; name: string; stage: Stage; amount: number; probability: number; expectedValue: number }[];
}

export interface Outlook {
  horizonDays: number;
  asOf: string;
  runs: number;
  /** Open deals left out because they are expected to close after the horizon. */
  later: number;
  byCurrency: CurrencyOutlook[];
  whatIf?: { stage: Stage; winRateChange: number; byCurrency: CurrencyOutlook[] };
}

export function pipelineOutlook(deals: readonly Deal[], scores: ReadonlyMap<string, Score>, now: Date, opts: OutlookOptions = {}): Outlook {
  const horizonDays = opts.horizonDays ?? 90;
  const runs = opts.runs ?? 2000;
  const seed = opts.seed ?? 100;
  if (!(horizonDays >= 1 && horizonDays <= 730)) throw new Error("horizonDays must be from 1 to 730");
  if (!Number.isInteger(runs) || runs < 100 || runs > 20000) throw new Error("runs must be from 100 to 20000");
  if (opts.whatIf && (!OPEN_STAGES.includes(opts.whatIf.stage) || !Number.isFinite(opts.whatIf.winRateChange) || Math.abs(opts.whatIf.winRateChange) > 100)) {
    throw new Error("whatIf needs an open stage and a change from -100 to 100 percentage points");
  }
  const end = now.getTime() + horizonDays * DAY;
  const open = deals.filter((d) => OPEN_STAGES.includes(d.stage));
  // Overdue deals still count: they might close any day.
  const inHorizon = open.filter((d) => Date.parse(d.closeDate) <= end);
  const later = open.length - inHorizon.length;

  const run = (adjust: (d: Deal, p: number) => number): CurrencyOutlook[] => {
    const groups = new Map<string, Deal[]>();
    for (const d of inHorizon) {
      const c = d.currency || "USD";
      if (!groups.has(c)) groups.set(c, []);
      groups.get(c)!.push(d);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([currency, ds]) => {
      const probs = ds.map((d) => Math.min(1, Math.max(0, adjust(d, scores.get(d.id)?.probability ?? 0.25))));
      // One stream per deal, so changing one deal's odds leaves the others' luck alone.
      const streams = ds.map((d) => createRng(hashStr(`${seed}|${d.id}`)));
      const totals = new Float64Array(runs);
      for (let r = 0; r < runs; r++) {
        let sum = 0;
        for (let i = 0; i < ds.length; i++) if (streams[i]!.next() < probs[i]!) sum += ds[i]!.amount;
        totals[r] = sum;
      }
      totals.sort();
      const q = (p: number) => totals[Math.min(runs - 1, Math.floor(p * runs))]!;
      const expected = ds.reduce((s, d, i) => s + d.amount * probs[i]!, 0);
      const out: CurrencyOutlook = {
        currency,
        deals: ds.length,
        pipeline: ds.reduce((s, d) => s + d.amount, 0),
        expected,
        p10: q(0.1),
        p50: q(0.5),
        p90: q(0.9),
        drivers: ds
          .map((d, i) => ({ dealId: d.id, name: d.name, stage: d.stage, amount: d.amount, probability: probs[i]!, expectedValue: d.amount * probs[i]! }))
          .sort((a, b) => b.expectedValue - a.expectedValue)
          .slice(0, 5),
      };
      if (opts.target !== undefined) {
        let hit = 0;
        for (let r = 0; r < runs; r++) if (totals[r]! >= opts.target) hit++;
        out.probTarget = hit / runs;
      }
      return out;
    });
  };

  const result: Outlook = { horizonDays, asOf: now.toISOString(), runs, later, byCurrency: run((_, p) => p) };
  if (opts.whatIf) {
    const { stage, winRateChange } = opts.whatIf;
    result.whatIf = { stage, winRateChange, byCurrency: run((d, p) => (d.stage === stage ? p + winRateChange / 100 : p)) };
  }
  return result;
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
}

export interface WeeklySeries {
  /** Monday (UTC) starting each week, oldest first. The last week is the current one. */
  weeks: string[];
  series: {
    wonValue: number[];
    wonDeals: number[];
    newDeals: number[];
    activities: number[];
    inbound: number[];
  };
}

/** The last `weeks` weeks (including the current one) as weekly totals. */
export function weeklySeries(deals: readonly Deal[], activities: readonly Activity[], now: Date, weeks = 26): WeeklySeries {
  if (!Number.isInteger(weeks) || weeks < 2 || weeks > 260) throw new Error("weeks must be from 2 to 260");
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const monday = day.getTime() - ((day.getUTCDay() + 6) % 7) * DAY;
  const start = monday - (weeks - 1) * 7 * DAY;
  const idx = (iso: string) => {
    const t = Date.parse(iso);
    if (!Number.isFinite(t) || t < start || t >= monday + 7 * DAY) return -1;
    return Math.floor((t - start) / (7 * DAY));
  };
  const zero = () => Array<number>(weeks).fill(0);
  const s = { wonValue: zero(), wonDeals: zero(), newDeals: zero(), activities: zero(), inbound: zero() };
  for (const d of deals) {
    const c = idx(d.createdAt);
    if (c >= 0) s.newDeals[c]!++;
    if (d.stage === "won") {
      const w = idx(d.stageEnteredAt);
      if (w >= 0) {
        s.wonDeals[w]!++;
        s.wonValue[w]! += d.amount;
      }
    }
  }
  for (const a of activities) {
    const w = idx(a.at);
    if (w < 0) continue;
    s.activities[w]!++;
    if (a.inbound) s.inbound[w]!++;
  }
  return { weeks: Array.from({ length: weeks }, (_, i) => new Date(start + i * 7 * DAY).toISOString().slice(0, 10)), series: s };
}
