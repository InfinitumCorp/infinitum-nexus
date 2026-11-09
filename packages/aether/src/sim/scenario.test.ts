import { test } from "node:test";
import assert from "node:assert/strict";
import { runScenario } from "./scenario.ts";

// M1 exit criterion (docs/SPEC.md, ÆTHER Build Plan): >=99% delivery across 6+ hops with 20% churn.
test("M1 exit: 100 nodes, 20% churn, 2% frame loss, pairs 6+ hops apart -> >=99% delivered", () => {
  const r = runScenario({ nodes: 100, churn: 0.2, minHops: 6, messages: 100, seed: 7 });
  console.log(JSON.stringify(r));
  assert.ok(r.pairHops.min >= 6);
  assert.ok(r.deliveryRate >= 0.99, `delivery ${(r.deliveryRate * 100).toFixed(1)}%`);
});

test("scenario is reproducible for a seed (except key material)", () => {
  const a = runScenario({ nodes: 40, messages: 20, minHops: 4, seed: 11, range: 0.3, durationMs: 20 * 60_000 });
  const b = runScenario({ nodes: 40, messages: 20, minHops: 4, seed: 11, range: 0.3, durationMs: 20 * 60_000 });
  assert.deepEqual(a.pairHops, b.pairHops);
  assert.equal(a.graphDiameter, b.graphDiameter);
});
