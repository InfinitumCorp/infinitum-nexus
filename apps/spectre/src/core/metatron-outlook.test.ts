import { test } from "node:test";
import assert from "node:assert/strict";
import { pipelineOutlook, weeklySeries } from "./metatron-outlook.ts";
import type { Score } from "./intelligence.ts";
import type { Activity, Deal } from "./model.ts";

const deal = (id: string, over: Partial<Deal> = {}): Deal => ({
  id, workspace: "w", companyId: "c", name: id, market: "commercial" as Deal["market"], stage: "proposal", amount: 10_000, currency: "USD",
  closeDate: "2026-04-01", ownerCid: "o", contactIds: [], stageEnteredAt: "2026-03-01T00:00:00Z",
  createdAt: "2026-03-01T00:00:00Z", updatedAt: "2026-03-01T00:00:00Z", ...over,
});
const score = (dealId: string, probability: number): Score => ({ dealId, probability, base: 0.25, factors: [], risk: "low" });
const now = new Date("2026-03-04T12:00:00Z"); // a Wednesday

test("outlook: sure deals give an exact total; ranges bracket the expectation", () => {
  const deals = [deal("a"), deal("b", { amount: 30_000 }), deal("c", { stage: "won" }), deal("d", { closeDate: "2027-01-01" })];
  const certain = pipelineOutlook(deals, new Map([["a", score("a", 1)], ["b", score("b", 1)]]), now);
  assert.equal(certain.byCurrency[0]!.p10, 40_000);
  assert.equal(certain.byCurrency[0]!.p90, 40_000);
  assert.equal(certain.later, 1);
  assert.equal(certain.byCurrency[0]!.deals, 2, "won deals are not pipeline");

  const many = Array.from({ length: 40 }, (_, i) => deal(`d${i}`));
  const scores = new Map(many.map((d) => [d.id, score(d.id, 0.5)]));
  const o = pipelineOutlook(many, scores, now, { target: 200_000, whatIf: { stage: "proposal", winRateChange: 20 } });
  const c = o.byCurrency[0]!;
  assert.equal(c.expected, 200_000);
  assert.ok(c.p10 < 200_000 && c.p90 > 200_000);
  assert.ok(c.probTarget! > 0.4 && c.probTarget! < 0.7, `${c.probTarget}`);
  assert.ok(Math.abs(o.whatIf!.byCurrency[0]!.expected - 280_000) < 1e-6);
  assert.ok(o.whatIf!.byCurrency[0]!.probTarget! > 0.95);
  // Deterministic.
  assert.deepEqual(pipelineOutlook(many, scores, now, { target: 200_000 }).byCurrency, pipelineOutlook(many, scores, now, { target: 200_000 }).byCurrency);
});

test("outlook: currencies are kept apart and bad input is rejected", () => {
  const o = pipelineOutlook([deal("a"), deal("e", { currency: "EUR", amount: 5 })], new Map(), now);
  assert.deepEqual(o.byCurrency.map((c) => c.currency), ["EUR", "USD"]);
  assert.throws(() => pipelineOutlook([], new Map(), now, { horizonDays: 0 }), /horizonDays/);
  assert.throws(() => pipelineOutlook([], new Map(), now, { whatIf: { stage: "won", winRateChange: 5 } }), /open stage/);
});

test("weeklySeries buckets by Monday-starting UTC weeks", () => {
  const deals = [
    deal("x", { createdAt: "2026-03-02T00:00:00Z" }), // this week (Mon)
    deal("y", { createdAt: "2026-03-01T23:59:00Z", stage: "won", stageEnteredAt: "2026-02-24T10:00:00Z", amount: 7 }), // last week
    deal("z", { createdAt: "2025-01-01T00:00:00Z" }), // too old
  ];
  const acts = [
    { id: "1", at: "2026-03-04T08:00:00Z", inbound: true } as Activity,
    { id: "2", at: "2026-02-23T08:00:00Z" } as Activity,
    { id: "3", at: "2026-03-09T08:00:00Z" } as Activity, // next week: ignored
  ];
  const w = weeklySeries(deals, acts, now, 4);
  assert.deepEqual(w.weeks, ["2026-02-09", "2026-02-16", "2026-02-23", "2026-03-02"]);
  assert.deepEqual(w.series.newDeals, [0, 0, 1, 1]);
  assert.deepEqual(w.series.wonValue, [0, 0, 7, 0]);
  assert.deepEqual(w.series.activities, [0, 0, 1, 1]);
  assert.deepEqual(w.series.inbound, [0, 0, 0, 1]);
  assert.throws(() => weeklySeries([], [], now, 1), /weeks/);
});
