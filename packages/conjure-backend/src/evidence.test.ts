import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateArtifacts,
  cyberSignals,
  exerciseSignals,
} from "./evidence.ts";
import { CONJURE_PRODUCT_PRESETS, productPreset } from "@infinitum/conjure";
test("every implemented canonical product has private capacity coverage; registry-only THRONE is excluded", () => {
  assert.ok(CONJURE_PRODUCT_PRESETS.length > 20);
  assert.ok(!CONJURE_PRODUCT_PRESETS.some((p) => p.product === "throne"));
  for (const p of CONJURE_PRODUCT_PRESETS)
    assert.equal(productPreset(p.product, "storage").dataSaleAllowed, false);
  assert.throws(() => productPreset("throne", "storage"));
});
test("telemetry projects battery diagnostics only, discarding positions, vehicle IDs and payload strings", () => {
  const value = aggregateArtifacts(
    "telemetry",
    [
      {
        product: "daemon",
        observations: [
          { kind: "globalPosition", data: { latDeg: 45, lonDeg: 30 } },
          {
            kind: "systemStatus",
            data: { batteryPct: 80, person: "private-name" },
          },
          { kind: "systemStatus", data: { batteryPct: null } },
        ],
      },
    ],
    "daemon",
    new Date(),
  );
  assert.equal(value.metrics.meanBatteryPct, 80);
  assert.equal(value.metrics.missingBatterySamples, 1);
  assert.ok(!JSON.stringify(value).includes("private-name"));
  assert.ok(!JSON.stringify(value).includes("latDeg"));
});
test("delivery snapshots contain backlog/attempt counts, not payload content", () => {
  const value = aggregateArtifacts(
    "delivery",
    [
      {
        product: "fabric",
        delivery: "pending",
        attempts: 2,
        createdAt: "2026-11-07T00:00:00Z",
        event: { payload: "private-message" },
      },
    ],
    "fabric",
    new Date("2026-11-07T01:00:00Z"),
  );
  assert.equal(value.metrics.pending, 1);
  assert.equal(value.metrics.totalAttempts, 2);
  assert.equal(value.metrics.oldestPendingSeconds, 3600);
  assert.ok(!JSON.stringify(value).includes("private-message"));
});
test("orbital summaries omit coordinates/targets and retain only offline estimate statistics", () => {
  const value = aggregateArtifacts(
    "orbital",
    [
      {
        product: "orbis",
        simulationOnly: true,
        kind: "budgets",
        data: { marginDb: -2, station: { latitudeDeg: 1 } },
      },
    ],
    "orbis",
    new Date(),
  );
  assert.equal(value.metrics.minimumIllustrativeMarginDb, -2);
  assert.ok(!JSON.stringify(value).includes("latitude"));
});
test("cyber and exercise producers compute numeric aggregate checkpoints from actual result codes", () => {
  assert.deepEqual(cyberSignals([200, 403, 500]), {
    requests: 3,
    failures: 1,
    denied: 1,
  });
  assert.deepEqual(exerciseSignals([true, false, true]), {
    trials: 3,
    failedTrials: 1,
  });
  assert.throws(() => cyberSignals([900]));
});
for (const kind of [
  "telemetry",
  "delivery",
  "orbital",
  "cyber",
  "exercise",
] as const)
  test(`${kind} rejects empty or invalid product evidence`, () => {
    assert.throws(() => aggregateArtifacts(kind, [], "daemon", new Date()));
    assert.throws(() => aggregateArtifacts(kind, [{}], "daemon", new Date()));
  });
