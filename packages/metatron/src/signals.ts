/**
 * METATRON signals: notice what matters.
 *
 * - `anomalies`: points that are far from what the recent past predicts.
 *   Each point is judged only against the window *before* it, using the
 *   median and the median absolute deviation (MAD), so one spike can't hide
 *   the next and a big outlier doesn't widen the yardstick for itself.
 * - `changePoints`: where a series' level shifted and stayed shifted
 *   (binary segmentation on the mean, with a minimum segment length).
 * - `digest`: across many series, the latest notable moves ranked by how
 *   unusual they are, each with a one-line explanation.
 */
import { quantileSorted } from "./distributions.ts";

export interface Anomaly {
  index: number;
  value: number;
  /** What the recent past suggested (median of the window, plus the seasonal offset if a period is given). */
  expected: number;
  /** Robust z-score: (value − expected) / (1.4826 × MAD). */
  score: number;
  direction: "up" | "down";
}

export interface AnomalyOptions {
  /** How many earlier points to judge each point against (default 30). */
  window?: number;
  /** |score| at or above this is an anomaly (default 3.5). */
  threshold?: number;
  /** Season length; compares each point with the same phase in earlier seasons. */
  period?: number;
}

const median = (xs: readonly number[]) => quantileSorted([...xs].sort((a, b) => a - b), 0.5);

/** Scale of a robust z-score; a floor stops perfectly flat history from dividing by zero. */
function robustScale(xs: readonly number[], center: number): number {
  const mad = median(xs.map((x) => Math.abs(x - center)));
  const s = 1.4826 * mad;
  if (s > 0) return s;
  const mean = xs.reduce((a, b) => a + Math.abs(b), 0) / xs.length;
  return Math.max(1e-9, mean * 0.01);
}

export function anomalies(values: readonly number[], opts: AnomalyOptions = {}): Anomaly[] {
  // 30 points at 3.5: about 0.3 false alarms per 84 points of pure noise, and 85% of 5σ spikes caught.
  const window = opts.window ?? 30;
  const threshold = opts.threshold ?? 3.5;
  const period = opts.period;
  if (!Number.isInteger(window) || window < 4) throw new Error("window must be at least 4");
  if (period !== undefined && (!Number.isInteger(period) || period < 2)) throw new Error("period must be at least 2");
  const out: Anomaly[] = [];
  // Values flagged as anomalies are replaced by their expectation in later windows,
  // so a run of spikes doesn't become "normal".
  const clean = [...values];
  const first = period ? Math.max(window, period + 4) : window;
  for (let i = first; i < values.length; i++) {
    const v = values[i]!;
    if (!Number.isFinite(v)) continue;
    let past: number[];
    let base = 0;
    if (period) {
      // Seasonal differencing: compare with the same phase one season ago,
      // plus the typical season-over-season change in the window.
      past = [];
      for (let j = Math.max(period, i - window); j < i; j++) {
        const d = clean[j]! - clean[j - period]!;
        if (Number.isFinite(d)) past.push(d);
      }
      base = clean[i - period]!;
      if (!Number.isFinite(base)) continue;
    } else {
      past = clean.slice(i - window, i).filter(Number.isFinite);
    }
    if (past.length < 4) continue;
    const center = median(past);
    const scale = robustScale(past, center);
    const expected = center + base;
    const score = (v - expected) / scale;
    if (Math.abs(score) >= threshold) {
      out.push({ index: i, value: v, expected, score, direction: score > 0 ? "up" : "down" });
      // Clip to the edge of normal (winsorize) rather than to the expectation:
      // replacing with the expectation shrinks later windows and makes the next
      // season's comparison look odd, which cascades into false alarms.
      clean[i] = expected + Math.sign(score) * threshold * scale;
    }
  }
  return out;
}

export interface ChangePoint {
  /** First index of the new level. */
  index: number;
  before: number;
  after: number;
  /** after − before. */
  shift: number;
  /** Shift in units of the noise (higher is clearer). */
  strength: number;
}

/**
 * Level shifts by binary segmentation. A split is kept when the shift is at
 * least `threshold` noise-widths, measured with a t-like statistic.
 */
export function changePoints(values: readonly number[], opts: { minSegment?: number; threshold?: number; max?: number } = {}): ChangePoint[] {
  const minSeg = opts.minSegment ?? 5;
  const threshold = opts.threshold ?? 4;
  const max = opts.max ?? 8;
  const xs = values.filter(Number.isFinite);
  if (xs.length !== values.length) throw new Error("changePoints needs a series without gaps");
  // Noise from first differences, robust to the shifts themselves.
  const diffs = xs.slice(1).map((v, i) => v - xs[i]!);
  if (diffs.length < 2) return [];
  const sigma = Math.max(1e-9, (1.4826 * median(diffs.map((d) => Math.abs(d - median(diffs))))) / Math.SQRT2);
  const found: ChangePoint[] = [];
  const mean = (a: number, b: number) => {
    let s = 0;
    for (let i = a; i < b; i++) s += xs[i]!;
    return s / (b - a);
  };
  const split = (a: number, b: number) => {
    if (found.length >= max || b - a < 2 * minSeg) return;
    let best = -1;
    let bestStat = 0;
    for (let k = a + minSeg; k <= b - minSeg; k++) {
      const n1 = k - a;
      const n2 = b - k;
      const stat = Math.abs(mean(k, b) - mean(a, k)) / (sigma * Math.sqrt(1 / n1 + 1 / n2));
      if (stat > bestStat) {
        bestStat = stat;
        best = k;
      }
    }
    if (best < 0 || bestStat < threshold) return;
    // The mean can be dragged by one outlier near the edge; the shift must hold on the medians too.
    const robust = Math.abs(median(xs.slice(best, b)) - median(xs.slice(a, best))) / (sigma * Math.sqrt(1 / (best - a) + 1 / (b - best)));
    if (robust < threshold) return;
    found.push({ index: best, before: 0, after: 0, shift: 0, strength: 0 });
    split(a, best);
    split(best, b);
  };
  split(0, xs.length);
  // Levels come from the neighbouring segments, not the segment that was split.
  const cuts = found.map((c) => c.index).sort((p, q) => p - q);
  return cuts.map((index, i) => {
    // Typical (median) level of each neighbouring segment.
    const before = median(xs.slice(i === 0 ? 0 : cuts[i - 1]!, index));
    const after = median(xs.slice(index, i === cuts.length - 1 ? xs.length : cuts[i + 1]!));
    return { index, before, after, shift: after - before, strength: Math.abs(after - before) / sigma };
  });
}

export interface DigestItem {
  series: string;
  kind: "anomaly" | "shift";
  index: number;
  /** Larger is more unusual; comparable across series. */
  score: number;
  direction: "up" | "down";
  value: number;
  expected: number;
  headline: string;
}

/**
 * The few things that changed, across every series given, most unusual
 * first. Only looks at the last `recent` points (default 3), because the
 * command center cares about what just happened.
 */
export function digest(
  series: Record<string, readonly number[]>,
  opts: { recent?: number; limit?: number; period?: number; labels?: Record<string, string> } = {},
): DigestItem[] {
  const recent = opts.recent ?? 3;
  const limit = opts.limit ?? 10;
  const items: DigestItem[] = [];
  // Whole numbers from 100 up; two significant decimals below.
  const fmt = (v: number) => (Math.abs(v) >= 100 ? Math.round(v).toLocaleString("en-US") : String(Number(v.toPrecision(3))));
  for (const [name, values] of Object.entries(series)) {
    if (values.length < 8) continue;
    const label = opts.labels?.[name] ?? name;
    const from = values.length - recent;
    // Shifts first: a new level that started recently, with a few points of evidence.
    const shifts = changePoints(values, { minSegment: Math.max(3, Math.min(5, Math.floor(values.length / 4))) })
      .filter((c) => c.index >= values.length - Math.max(recent * 4, 12));
    for (const c of shifts) {
      items.push({
        series: name,
        kind: "shift",
        index: c.index,
        score: c.strength,
        direction: c.shift > 0 ? "up" : "down",
        value: c.after,
        expected: c.before,
        headline: `${label} moved to a new level: about ${fmt(c.after)}, from ${fmt(c.before)}`,
      });
    }
    for (const a of anomalies(values, { period: opts.period, window: Math.min(30, values.length - 1) })) {
      if (a.index < from) continue;
      // Already explained by a shift in the same direction.
      if (shifts.some((c) => a.index >= c.index && (c.shift > 0) === (a.direction === "up"))) continue;
      const pct = a.expected !== 0 ? Math.round(((a.value - a.expected) / Math.abs(a.expected)) * 100) : NaN;
      items.push({
        series: name,
        kind: "anomaly",
        index: a.index,
        score: Math.abs(a.score),
        direction: a.direction,
        value: a.value,
        expected: a.expected,
        headline: `${label} ${a.direction === "up" ? "jumped" : "dropped"} to ${fmt(a.value)}${Number.isNaN(pct) ? "" : ` (${pct > 0 ? "+" : ""}${pct}% vs. about ${fmt(a.expected)} expected)`}`,
      });
    }
  }
  return items.sort((a, b) => b.score - a.score).slice(0, limit);
}
