import { test } from "node:test";
import assert from "node:assert/strict";
import { TEMPLATES, templateById } from "./templates.ts";
import { compare, sensitivity, validateModel } from "./simulate.ts";

test("every template is valid and every intervention runs", () => {
  const ids = new Set<string>();
  for (const t of TEMPLATES) {
    assert.ok(!ids.has(t.id), `duplicate id ${t.id}`);
    ids.add(t.id);
    validateModel(t.model);
    const cmp = compare(t.model, t.interventions, { runs: 60, seed: 1, events: t.events });
    assert.equal(cmp.scenarios.length, t.interventions.length);
    assert.ok(t.focus in cmp.baseline.final, `${t.id}: focus ${t.focus}`);
    for (const s of [cmp.baseline, ...cmp.scenarios]) {
      for (const [k, v] of Object.entries(s.final)) assert.ok(Number.isFinite(v.mean), `${t.id}/${s.name}/${k} is ${v.mean}`);
    }
  }
  assert.equal(templateById("cash-runway")?.title, "Cash runway");
  assert.equal(templateById("nope"), undefined);
});

test("templates behave the way their questions suggest", () => {
  const rate = templateById("rate-decision")!;
  const r = compare(rate.model, rate.interventions, { runs: 200, seed: 2 });
  const hike = r.scenarios.find((s) => s.name === "Hike to 5.75%")!;
  const cut = r.scenarios.find((s) => s.name === "Cut to 4.75%")!;
  assert.ok(hike.delta.cash!.mean < 0 && cut.delta.cash!.mean > 0);

  const supply = templateById("supply-delay")!;
  const s = compare(supply.model, supply.interventions, { runs: 200, seed: 3, events: supply.events });
  const slip = s.scenarios.find((x) => x.name === "Supplier slips 6 weeks")!;
  assert.ok(slip.delta.lostSales!.mean > 0);
  assert.ok(slip.events.stockout!.probability > s.baseline.events.stockout!.probability);

  const runway = templateById("cash-runway")!;
  const c = compare(runway.model, runway.interventions, { runs: 200, seed: 4, events: runway.events });
  const raise = c.scenarios.find((x) => x.name === "Raise $1.5M in month 9")!;
  assert.ok(raise.events.outOfCash!.probability <= c.baseline.events.outOfCash!.probability);
  assert.ok(Math.abs(raise.delta.cash!.mean - 1500000) < 1, "same draws: raising adds exactly the raise");

  const top = sensitivity(runway.model, "cash", { runs: 100, seed: 5 });
  assert.equal(top[0]!.variable, "growth");
});
