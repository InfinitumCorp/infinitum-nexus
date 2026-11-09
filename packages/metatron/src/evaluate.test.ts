import { test } from "node:test";
import assert from "node:assert/strict";
import { auc, brier, calibration, evaluate, forecastError, logLoss } from "./evaluate.ts";

test("brier and log loss are zero-ish for perfect predictions", () => {
  const rows = [{ probability: 1, outcome: true }, { probability: 0, outcome: false }];
  assert.equal(brier(rows), 0);
  assert.ok(logLoss(rows) < 1e-9);
});

test("brier of coin flip is 0.25", () => {
  assert.equal(brier([{ probability: 0.5, outcome: true }, { probability: 0.5, outcome: false }]), 0.25);
});

test("auc: perfect ranking is 1, reversed is 0, all ties is 0.5", () => {
  const good = [{ probability: 0.9, outcome: true }, { probability: 0.1, outcome: false }];
  const bad = [{ probability: 0.1, outcome: true }, { probability: 0.9, outcome: false }];
  const tie = [{ probability: 0.5, outcome: true }, { probability: 0.5, outcome: false }];
  assert.equal(auc(good), 1);
  assert.equal(auc(bad), 0);
  assert.equal(auc(tie), 0.5);
  assert.ok(Number.isNaN(auc([{ probability: 0.4, outcome: true }])));
});

test("calibration bins skip empty bins and include p=1 in the last bin", () => {
  const bins = calibration([{ probability: 1, outcome: true }, { probability: 0.1, outcome: false }], 5);
  assert.equal(bins.length, 2);
  assert.equal(bins[1]!.observedRate, 1);
});

test("evaluate: base-rate predictions have zero skill", () => {
  const rows = [true, false, false, false].map((o) => ({ probability: 0.25, outcome: o }));
  const e = evaluate(rows);
  assert.equal(e.baseRate, 0.25);
  assert.ok(Math.abs(e.brierSkill) < 1e-12);
});

test("forecastError", () => {
  const e = forecastError([10, 20], [12, 18]);
  assert.equal(e.mae, 2);
  assert.equal(e.rmse, 2);
  assert.equal(forecastError([0], [0]).smape, 0);
});
