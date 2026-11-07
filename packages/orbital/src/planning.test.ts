import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOmm } from "./orbit.ts";
import { predictPasses, scheduleContacts, linkBudget } from "./planning.ts";
import { omm } from "./fixtures.ts";
const station = {
  id: "test",
  latitudeDeg: 0,
  longitudeDeg: 0,
  heightM: 0,
  minElevationDeg: 10,
};
const request = (
  id: string,
  start: string,
  end: string,
  priority = 0,
  stationId = "s1",
  satelliteId = "sat1",
) => ({
  id,
  start: `2026-11-07T${start}:00Z`,
  end: `2026-11-07T${end}:00Z`,
  priority,
  stationId,
  satelliteId,
});
test("pass predictions are bounded, deterministic, ordered and above elevation mask", () => {
  const orbit = parseOmm(omm),
    options = {
      station,
      start: "2026-11-07T00:00:00Z",
      end: "2026-11-08T00:00:00Z",
      stepSeconds: 60,
    };
  const result = predictPasses(orbit, options);
  assert.deepEqual(predictPasses(orbit, options), result);
  assert.ok(result.passes.length > 0);
  assert.ok(result.evaluations <= 8192);
  for (const p of result.passes) {
    assert.ok(p.start < p.end);
    assert.ok(p.peakAt >= p.start && p.peakAt <= p.end);
    assert.ok(p.maxElevationDeg >= 10);
    assert.ok(p.rangeAtPeakKm > 0);
    assert.equal(p.clippedStart, false);
    assert.equal(p.clippedEnd, false);
  }
  assert.equal(result.simulationOnly, true);
});
test("a window inside a pass marks both boundaries as clipped", () => {
  const orbit = parseOmm(omm),
    pass = predictPasses(orbit, {
      station,
      start: "2026-11-07T00:00:00Z",
      end: "2026-11-08T00:00:00Z",
      stepSeconds: 60,
    }).passes[0]!;
  const middle = Date.parse(pass.peakAt),
    r = predictPasses(orbit, {
      station,
      start: new Date(middle - 1000).toISOString(),
      end: new Date(middle + 1000).toISOString(),
      stepSeconds: 5,
    });
  assert.equal(r.passes.length, 1);
  assert.equal(r.passes[0]!.clippedStart, true);
  assert.equal(r.passes[0]!.clippedEnd, true);
});
test("pass requests reject invalid stations, windows, ages and excessive sampling", () => {
  const orbit = parseOmm(omm),
    base = {
      station,
      start: "2026-11-07T00:00:00Z",
      end: "2026-11-08T00:00:00Z",
      stepSeconds: 60,
    };
  for (const patch of [
    { station: { ...station, latitudeDeg: 91 } },
    { station: { ...station, minElevationDeg: 90 } },
    { end: base.start },
    { end: "2026-11-09T00:00:00Z" },
    { stepSeconds: 5 },
    { start: "2027-01-01T00:00:00Z", end: "2027-01-01T01:00:00Z" },
  ])
    assert.throws(() => predictPasses(orbit, { ...base, ...patch }));
});
test("contact proposals greedily prioritize requests and reject station and satellite conflicts", () => {
  const requests = [
    request("low", "01:00", "01:10", 1),
    request("high", "01:05", "01:15", 10),
    request("other-station", "01:06", "01:16", 2, "s2"),
    request("independent", "01:06", "01:16", 0, "s2", "sat2"),
  ];
  const plan = scheduleContacts(requests, { turnaroundSeconds: 0 });
  assert.deepEqual(
    plan.accepted.map((x) => x.id),
    ["high", "independent"],
  );
  assert.equal(plan.rejected.length, 2);
  assert.equal(plan.visibilityVerified, false);
  assert.deepEqual(
    scheduleContacts([...requests].reverse(), { turnaroundSeconds: 0 }),
    plan,
  );
});
test("half-open adjacent contacts fit with no turnaround but guard intervals and fixed reservations win", () => {
  const a = request("a", "01:00", "01:10", 1),
    b = request("b", "01:10", "01:20", 1);
  assert.equal(
    scheduleContacts([a, b], { turnaroundSeconds: 0 }).accepted.length,
    2,
  );
  assert.equal(
    scheduleContacts([a, b], { turnaroundSeconds: 1 }).accepted.length,
    1,
  );
  const result = scheduleContacts([b], {
    turnaroundSeconds: 60,
    existing: [a],
  });
  assert.equal(result.accepted.length, 0);
  assert.deepEqual(result.rejected[0]?.conflicts, ["a"]);
});
test("contact validation bounds arrays, priorities, duplicate ids, horizons and contradictory reservations", () => {
  const a = request("a", "01:00", "01:10");
  assert.throws(() => scheduleContacts([a, a], {}));
  assert.throws(() => scheduleContacts([{ ...a, priority: 101 }], {}));
  assert.throws(() => scheduleContacts([{ ...a, end: a.start }], {}));
  assert.throws(() => scheduleContacts(Array(129).fill(a), {}));
  assert.throws(() =>
    scheduleContacts([], { existing: [a, { ...a, id: "b" }] }),
  );
  assert.throws(() => scheduleContacts([a], { turnaroundSeconds: -1 }));
});
test("free-space link budget matches Friis and thermal-noise equations", () => {
  const r = linkBudget({
    distanceKm: 1000,
    frequencyHz: 1e9,
    txPowerDbm: 30,
    txGainDbi: 20,
    rxGainDbi: 20,
    txLossDb: 1,
    rxLossDb: 2,
    otherLossDb: 3,
    bandwidthHz: 1e6,
    noiseTemperatureK: 290,
    requiredSnrDb: 10,
  });
  assert.ok(Math.abs(r.freeSpaceLossDb - 152.44778322188338) < 1e-9);
  assert.ok(Math.abs(r.receivedPowerDbm - -88.44778322188338) < 1e-9);
  assert.ok(Math.abs(r.noisePowerDbm - -113.97518719422808) < 1e-9);
  assert.ok(Math.abs(r.marginDb - 15.5274039723447) < 1e-8);
  assert.equal(r.freeSpaceOnly, true);
});
test("link budgets reject zero, infinity and unsupported units/fields", () => {
  assert.throws(() => linkBudget({ distanceKm: 0 }));
  assert.throws(() => linkBudget({ distanceKm: Infinity }));
});
