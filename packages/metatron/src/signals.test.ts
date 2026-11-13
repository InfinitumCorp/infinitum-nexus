import { test } from "node:test";
import assert from "node:assert/strict";
import { anomalies, changePoints, digest } from "./signals.ts";
import { forecast, normalQuantile, holtWinters, seasonalNaive } from "./forecast.ts";
import { createRng } from "./rng.ts";

const noisy = (n: number, f: (i: number) => number, sd = 1, seed = 1) => {
  const r = createRng(seed);
  return Array.from({ length: n }, (_, i) => f(i) + r.normal(0, sd));
};

test("normalQuantile matches known values", () => {
  assert.ok(Math.abs(normalQuantile(0.975) - 1.959964) < 1e-5);
  assert.ok(Math.abs(normalQuantile(0.5)) < 1e-12);
  assert.ok(Math.abs(normalQuantile(0.01) + 2.326348) < 1e-5);
});

test("forecast picks a trend model for trending data and its range covers the truth", () => {
  const values = noisy(60, (i) => 100 + 3 * i, 2);
  const f = forecast(values, 6, { level: 0.9 });
  assert.ok(["drift", "last-delta", "holt", "holt-smooth", "holt-fast"].includes(f.model) && f.model !== "naive", f.model);
  assert.equal(f.intervals, "empirical");
  assert.equal(f.point.length, 6);
  for (let k = 0; k < 6; k++) {
    const truth = 100 + 3 * (60 + k);
    assert.ok(f.lower[k]! <= truth && truth <= f.upper[k]!, `step ${k}: ${f.lower[k]} ≤ ${truth} ≤ ${f.upper[k]}`);
    assert.ok(f.lower[k]! <= f.point[k]! && f.point[k]! <= f.upper[k]!);
    if (k > 0) assert.ok(f.upper[k]! - f.lower[k]! >= f.upper[k - 1]! - f.lower[k - 1]! - 1e-9, "ranges never narrow");
  }
  assert.equal(f.candidates[0]!.model, f.model);
  assert.ok(f.error!.mae > 0);
});

test("forecast uses the seasonal pattern when given a period", () => {
  const weekly = [10, 12, 11, 13, 30, 35, 8];
  const values = noisy(70, (i) => weekly[i % 7]!, 0.5, 4);
  const f = forecast(values, 7, { period: 7 });
  assert.match(f.model, /seasonal|winters/);
  for (let k = 0; k < 7; k++) assert.ok(Math.abs(f.point[k]! - weekly[(70 + k) % 7]!) < 3, `${k}: ${f.point[k]}`);
  const hw = holtWinters(7)(values, 7);
  const sn = seasonalNaive(7)(values, 7);
  assert.equal(hw.length, 7);
  assert.deepEqual(sn, values.slice(63, 70));
});

test("forecast never goes below zero for a non-negative series unless told to", () => {
  const counts = noisy(40, () => 1, 1.5, 9).map((v) => Math.max(0, Math.round(v)));
  const f = forecast(counts, 6, { level: 0.95 });
  assert.ok(f.lower.every((v) => v >= 0) && f.point.every((v) => v >= 0));
  const free = forecast(counts, 6, { level: 0.95, floor: -Infinity });
  assert.ok(free.lower.some((v) => v < 0), "without the floor the range would dip below zero");
  const signedSeries = counts.map((v) => v - 1);
  assert.ok(forecast(signedSeries, 3, { level: 0.95 }).lower.some((v) => v < 0), "series with negatives keep them");
});

test("forecast with very short history falls back to an approximate range", () => {
  const f = forecast([5, 6, 7], 3);
  assert.equal(f.intervals, "approximate");
  assert.deepEqual(f.point, [8, 9, 10]);
  assert.ok(f.upper[2]! - f.lower[2]! >= f.upper[0]! - f.lower[0]!);
  assert.throws(() => forecast([], 3), /no history/);
  assert.throws(() => forecast([1, NaN, 2], 3), /non-numeric/);
  assert.throws(() => forecast([1, 2], 0), /horizon/);
});

test("anomalies flag spikes and dips, judged only on the past", () => {
  const values = noisy(80, () => 50, 1, 7);
  values[40] = 70;
  values[41] = 71; // a second spike right after must still be caught
  values[60] = 35;
  const found = anomalies(values);
  const idx = found.map((a) => a.index);
  assert.ok(idx.includes(40) && idx.includes(41) && idx.includes(60), JSON.stringify(idx));
  assert.ok(found.length <= 5, `${found.length} flagged`);
  const spike = found.find((a) => a.index === 40)!;
  assert.equal(spike.direction, "up");
  assert.ok(Math.abs(spike.expected - 50) < 1.5);
  assert.equal(found.find((a) => a.index === 60)!.direction, "down");
  // Flat history doesn't divide by zero.
  assert.deepEqual(anomalies(Array(30).fill(5)), []);
  assert.throws(() => anomalies([1, 2, 3], { window: 2 }), /window/);
});

test("anomalies respect a weekly pattern instead of flagging every weekend", () => {
  const weekly = [10, 10, 10, 10, 10, 40, 40];
  const values = noisy(84, (i) => weekly[i % 7]!, 0.5, 3);
  // At most the measured false-alarm rate (~0.3 per 84 points), never "every weekend".
  const quiet = anomalies(values, { period: 7 }).map((a) => a.index);
  assert.ok(quiet.length <= 1, JSON.stringify(quiet));
  values[72] = 40; // a weekday (72 % 7 = 2) that looks like a weekend
  const found = anomalies(values, { period: 7 }).map((a) => a.index);
  assert.ok(found.includes(72), JSON.stringify(found));
  assert.ok(found.length <= 2, JSON.stringify(found));
  assert.ok(anomalies(values).length >= 1, "without the period the weekends look odd");
});

test("changePoints finds level shifts and nothing in pure noise", () => {
  const values = noisy(90, (i) => (i < 30 ? 10 : i < 60 ? 20 : 5), 1, 11);
  const cps = changePoints(values);
  assert.equal(cps.length, 2, JSON.stringify(cps));
  assert.ok(Math.abs(cps[0]!.index - 30) <= 1 && Math.abs(cps[1]!.index - 60) <= 1);
  assert.ok(cps[0]!.shift > 8 && cps[1]!.shift < -12);
  assert.equal(changePoints(noisy(90, () => 10, 1, 12)).length, 0);
});

test("digest ranks what just happened across series", () => {
  const signups = noisy(40, () => 200, 5, 1);
  signups[39] = 320;
  const revenue = noisy(40, (i) => (i < 30 ? 1000 : 1400), 20, 2);
  const steady = noisy(40, () => 7, 0.2, 3);
  const old = noisy(40, () => 100, 2, 4);
  old[10] = 200; // long ago: not news
  const items = digest({ signups, revenue, steady, old }, { labels: { signups: "Sign-ups" } });
  const series = items.map((i) => i.series);
  assert.ok(series.includes("signups") && series.includes("revenue"), JSON.stringify(items));
  assert.ok(!series.includes("steady") && !series.includes("old"));
  const s = items.find((i) => i.series === "signups")!;
  assert.match(s.headline, /^Sign-ups jumped to 320 \(\+\d+% vs\. about (199|20\d) expected\)$/);
  const r = items.find((i) => i.series === "revenue")!;
  assert.equal(r.kind, "shift");
  // True levels are 1,400 and 1,000; medians of noisy segments land close.
  assert.match(r.headline, /new level: about 1,(3[5-9]|4[0-4])\d, from (9[5-9]\d|1,0[0-4]\d)$/);
  for (let i = 1; i < items.length; i++) assert.ok(items[i - 1]!.score >= items[i]!.score);
});
