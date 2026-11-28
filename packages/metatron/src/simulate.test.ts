import { test } from "node:test";
import assert from "node:assert/strict";
import { compile, ExprError } from "./expr.ts";
import { checkDist, sample, quantileSorted } from "./distributions.ts";
import { createRng } from "./rng.ts";
import { compare, sensitivity, simulate, validateModel, type ScenarioModel } from "./simulate.ts";

const r0 = createRng(1);

test("expressions: precedence, functions, comparisons", () => {
  const ev = (s: string, env: Record<string, number> = {}) => compile(s).run(env, r0);
  assert.equal(ev("1 + 2 * 3"), 7);
  assert.equal(ev("(1 + 2) * 3"), 9);
  assert.equal(ev("2 ^ 3 ^ 2"), 512);
  assert.equal(ev("-2 ^ 2"), -4);
  assert.equal(ev("10 % 4"), 2);
  assert.equal(ev("x > 3 ? x : 0", { x: 5 }), 5);
  assert.equal(ev("x > 3 ? x : 0", { x: 2 }), 0);
  assert.equal(ev("clamp(x, 0, 1)", { x: 7 }), 1);
  assert.equal(ev("max(1, 4, 2) + min(3, -1)"), 3);
  assert.equal(ev("a >= 1 && !(b == 2) || false", { a: 1, b: 3 }), 1);
  assert.equal(ev("1.5e2 + .5"), 150.5);
  assert.ok(Math.abs(ev("logistic(0)") - 0.5) < 1e-12);
});

test("expressions: reject unknown names, functions and junk", () => {
  assert.throws(() => compile("x + y", { names: new Set(["x"]) }), /unknown name "y"/);
  assert.throws(() => compile("eval(1)"), /unknown function "eval"/);
  assert.throws(() => compile("constructor.prototype"), ExprError);
  assert.throws(() => compile("1 +"), /unexpected end/);
  assert.throws(() => compile("clamp(1, 2)"), /takes 3/);
  assert.throws(() => compile("x = 1"), ExprError);
  assert.throws(() => compile("(".repeat(100) + "1" + ")".repeat(100)), /nested too deeply/);
  assert.deepEqual([...compile("a * b + a").names].sort(), ["a", "b"]);
});

test("distributions sample inside their support and reject bad input", () => {
  const r = createRng(7);
  const tri = checkDist("x", { kind: "triangular", min: 0, mode: 2, max: 8 });
  const draws = Float64Array.from({ length: 5000 }, () => sample(tri, r)).sort();
  assert.ok(draws[0]! >= 0 && draws[draws.length - 1]! <= 8);
  // Mean of a triangular is (a + b + c) / 3.
  const mean = draws.reduce((s, v) => s + v, 0) / draws.length;
  assert.ok(Math.abs(mean - 10 / 3) < 0.1, `${mean}`);
  const choice = checkDist("c", { kind: "choice", options: [{ value: 5.25, weight: 3 }, { value: 5.5, weight: 1 }] });
  const share = Array.from({ length: 4000 }, () => sample(choice, r)).filter((v) => v === 5.5).length / 4000;
  assert.ok(Math.abs(share - 0.25) < 0.03, `${share}`);
  const pois = checkDist("p", { kind: "poisson", lambda: 4 });
  const pm = Array.from({ length: 4000 }, () => sample(pois, r)).reduce((s, v) => s + v, 0) / 4000;
  assert.ok(Math.abs(pm - 4) < 0.15, `${pm}`);
  assert.equal(quantileSorted([1, 2, 3, 4], 0.5), 2.5);
  assert.throws(() => checkDist("u", { kind: "uniform", min: 2, max: 1 }), /min ≤ max/);
  assert.throws(() => checkDist("n", { kind: "normal", mean: 0, sd: -1 }), /sd ≥ 0/);
  assert.throws(() => checkDist("k", { kind: "nope" } as never), /unknown kind/);
});

/** A small business: customers grow and churn, price is uncertain, cash accumulates. */
const business: ScenarioModel = {
  name: "Shop",
  steps: 12,
  stepUnit: "month",
  variables: {
    growth: { kind: "normal", mean: 0.05, sd: 0.02 },
    price: { kind: "uniform", min: 40, max: 60 },
    churn: { kind: "triangular", min: 0.01, mode: 0.03, max: 0.06 },
  },
  shocks: { demand: { kind: "normal", mean: 0, sd: 0.03 } },
  state: { customers: 1000, cash: 10000 },
  derived: { revenue: "customers * price", costs: "20000 + customers * 10" },
  update: {
    customers: "max(0, customers * (1 + growth + demand - churn))",
    cash: "cash + revenue - costs",
  },
};

test("simulation is deterministic for a seed and reports bands", () => {
  const a = simulate(business, { runs: 300, seed: 9 });
  const b = simulate(business, { runs: 300, seed: 9 });
  assert.deepEqual(a.final, b.final);
  assert.equal(a.steps, 12);
  assert.equal(a.stepUnit, "month");
  const band = a.series.customers!;
  assert.equal(band.mean.length, 12);
  for (let s = 0; s < 12; s++) {
    assert.ok(band.p5[s]! <= band.p25[s]! && band.p25[s]! <= band.p50[s]! && band.p50[s]! <= band.p75[s]! && band.p75[s]! <= band.p95[s]!);
  }
  // Uncertainty widens with time.
  assert.ok(band.p95[11]! - band.p5[11]! > band.p95[0]! - band.p5[0]!);
  // Growth (5%) beats churn (~3.3%) on average.
  assert.ok(a.final.customers!.mean > 1000);
  // Neighbouring seeds must give different futures (regression: weak seed mixing made 9 and 10 identical).
  for (const s of [8, 10, 11, 13]) {
    const c = simulate(business, { runs: 300, seed: s });
    assert.notEqual(a.final.cash!.mean, c.final.cash!.mean, `seed ${s}`);
  }
});

test("compare: a pinned price moves revenue with paired differences", () => {
  const cmp = compare(business, [
    { name: "Raise price", description: "Price to 70", variables: { price: 70 } },
    { name: "Retention push", update: { customers: "max(0, customers * (1 + growth + demand - churn / 2))" }, from: 4 },
  ], { runs: 400, seed: 3, events: { broke: "cash < 0" } });
  assert.equal(cmp.baseline.name, "Shop");
  const [price, retention] = cmp.scenarios;
  assert.equal(price!.description, "Price to 70");
  // Price 70 is above every price the baseline can draw (40–60), so every run gains revenue.
  assert.equal(price!.delta.revenue!.probHigher, 1);
  assert.ok(price!.delta.cash!.mean > 0);
  // Same draws: a change from step 4 cannot touch steps 1–3.
  for (let s = 0; s < 3; s++) assert.equal(retention!.series.customers!.mean[s], cmp.baseline.series.customers!.mean[s]);
  assert.ok(retention!.series.customers!.mean[11]! > cmp.baseline.series.customers!.mean[11]!);
  assert.ok(retention!.delta.customers!.probHigher > 0.99);
  assert.equal(cmp.baseline.finalRuns, undefined);
  const broke = cmp.baseline.events.broke!;
  assert.ok(broke.probability >= broke.atEnd);
  assert.ok(price!.events.broke!.probability <= broke.probability);
});

test("pinning one variable leaves the other variables' draws unchanged", () => {
  const m: ScenarioModel = {
    steps: 1,
    variables: { a: { kind: "normal", mean: 0, sd: 1 }, b: { kind: "normal", mean: 0, sd: 1 } },
    state: { x: 0, y: 0 },
    update: { x: "a", y: "b" },
  };
  const cmp = compare(m, [{ name: "a pinned", variables: { a: 5 } }], { runs: 200, seed: 1 });
  assert.equal(cmp.scenarios[0]!.delta.y!.mean, 0);
  assert.equal(cmp.scenarios[0]!.delta.y!.p95, 0);
  assert.equal(cmp.scenarios[0]!.final.x!.sd, 0);
});

test("agents: adoption spreads through a population (Bass-style)", () => {
  const m: ScenarioModel = {
    steps: 20,
    variables: { innovation: 0.01, imitation: 0.4 },
    state: { adopters: 0 },
    agents: {
      count: 500,
      attributes: { openness: { kind: "uniform", min: 0.5, max: 1.5 } },
      state: { adopted: 0 },
      update: { adopted: "adopted == 1 ? 1 : bernoulli(clamp(openness * (innovation + imitation * mean_adopted), 0, 1))" },
    },
    update: { adopters: "sum_adopted" },
    outputs: ["adopters", "mean_adopted"],
  };
  const r = simulate(m, { runs: 40, seed: 5, events: { majority: "mean_adopted > 0.5" } });
  const adopters = r.series.adopters!.mean;
  for (let s = 1; s < adopters.length; s++) assert.ok(adopters[s]! >= adopters[s - 1]!, "adoption never falls");
  assert.ok(adopters[0]! < 25, `${adopters[0]}`);
  assert.ok(r.final.mean_adopted!.mean > 0.9, `${r.final.mean_adopted!.mean}`);
  assert.equal(r.events.majority!.probability, 1);
  assert.ok(r.events.majority!.medianFirstStep > 3 && r.events.majority!.medianFirstStep < 15);
});

test("sensitivity ranks the input that matters most first", () => {
  const rows = sensitivity(business, "cash", { runs: 150, seed: 2 });
  assert.equal(rows.length, 3);
  assert.equal(rows[0]!.variable, "price");
  assert.ok(rows[0]!.outputAtHigh > rows[0]!.outputAtLow);
  assert.ok(rows[0]!.low < rows[0]!.high);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1]!.swing >= rows[i]!.swing);
});

test("validation gives readable errors", () => {
  const bad = (m: Partial<ScenarioModel>, re: RegExp) => assert.throws(() => validateModel({ ...business, ...m } as ScenarioModel), re);
  bad({ steps: 0 }, /steps must be/);
  bad({ update: { nope: "1" } }, /unknown state "nope"/);
  bad({ derived: { revenue: "customers * prise", costs: "1" } }, /derived.revenue: unknown name "prise"/);
  bad({ state: { customers: 1, cash: "growth +" } }, /state.cash/);
  bad({ variables: { t: 1 } }, /reserved/);
  bad({ variables: { customers: 1 } }, /used twice/);
  bad({ outputs: ["profit"] }, /output "profit"/);
  bad({ derived: { revenue: "costs", costs: "1" } }, /unknown name "costs"/); // derived only sees earlier derived
  assert.throws(() => simulate(business, { runs: 0 }), /runs must be/);
  assert.throws(() => simulate({ ...business, steps: 1000, agents: { count: 100000, state: { a: 0 }, update: {} } }, { runs: 100 }), /too much work/);
  assert.throws(() => compare(business, [{ name: "x", variables: { nope: 1 } }]), /unknown variable "nope"/);
  assert.throws(() => compare(business, [{ name: "x" }, { name: "x" }]), /two interventions/);
  assert.throws(() => simulate(business, { events: { e: "cash <" } }), /event "e"/);
});
