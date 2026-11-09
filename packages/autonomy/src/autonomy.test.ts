import { test } from "node:test";
import assert from "node:assert/strict";
import { inside, legEntersPolygon, legInsidePolygon, type Polygon } from "./geo.ts";
import { checkMission } from "./mission.ts";
import { evaluate } from "./interlock.ts";
import { planCoverage, scheduleDocking } from "./swarm.ts";

const square = (s: number): Polygon => [
  { x: -s, y: -s },
  { x: s, y: -s },
  { x: s, y: s },
  { x: -s, y: s },
];
const FENCE = square(2000);
const HOME = { x: 0, y: 0 };

test("geometry: inside, concave fences and no-go legs", () => {
  assert.ok(inside({ x: 0, y: 0 }, FENCE));
  assert.ok(inside({ x: 2000, y: 0 }, FENCE), "edge counts as inside");
  assert.ok(!inside({ x: 2001, y: 0 }, FENCE));
  // An L-shaped fence: the straight leg between two inside points cuts the notch.
  const L: Polygon = [
    { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 40 }, { x: 40, y: 40 }, { x: 40, y: 100 }, { x: 0, y: 100 },
  ];
  assert.ok(!legInsidePolygon({ x: 90, y: 20 }, { x: 20, y: 90 }, L));
  assert.ok(legEntersPolygon({ x: -50, y: 0 }, { x: 150, y: 0 }, square(10)), "crossing leg enters");
  assert.ok(!legEntersPolygon({ x: -50, y: 50 }, { x: 150, y: 50 }, square(10)), "passing leg does not");
});

test("DAEMON survey inside the fence passes and still needs approval", () => {
  const r = checkMission({
    id: "m1",
    platform: "DAEMON",
    home: HOME,
    waypoints: [{ x: 1000, y: 0, altM: 100 }, { x: 1000, y: 1000, altM: 100, holdS: 60 }],
    fence: FENCE,
  });
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.equal(r.needsApproval, true);
  assert.ok(r.landingBattery > 0.2);
  assert.equal(r.distanceM, 3414);
});

test("mission check reports fence, no-go, altitude and energy problems", () => {
  const r = checkMission({
    id: "m2",
    platform: "DAEMON",
    home: HOME,
    waypoints: [{ x: 1500, y: 0, altM: 150 }, { x: 2500, y: 0, altM: 100 }],
    fence: FENCE,
    noGo: [square(50).map((p) => ({ x: p.x + 800, y: p.y }))],
  });
  const codes = r.issues.map((i) => i.code);
  assert.ok(codes.includes("leaves_fence"));
  assert.ok(codes.includes("enters_no_go"));
  assert.ok(codes.includes("altitude_too_high"));
  assert.equal(r.ok, false);

  const low = checkMission({ id: "m3", platform: "ORBIS", home: HOME, waypoints: [{ x: 1900, y: 1900, altM: 10 }], fence: FENCE, batteryAtLaunch: 0.5 });
  assert.ok(low.issues.some((i) => i.code === "insufficient_energy"));
});

test("SLUG is a ground vehicle and cannot be given altitude", () => {
  const r = checkMission({ id: "m4", platform: "SLUG", home: HOME, waypoints: [{ x: 100, y: 100, altM: 20 }], fence: FENCE });
  assert.deepEqual(r.issues.map((i) => i.code), ["altitude_on_ground_platform"]);
});

test("interlock escalates to the most severe action", () => {
  const cfg = { fence: FENCE, home: HOME, holdAfterS: 3, returnAfterS: 20 };
  assert.equal(evaluate("DAEMON", { position: { x: 100, y: 0 }, battery: 0.9, linkSilentS: 0 }, cfg).action, "continue");
  assert.equal(evaluate("DAEMON", { position: { x: 100, y: 0 }, battery: 0.9, linkSilentS: 5 }, cfg).action, "hold");
  assert.equal(evaluate("DAEMON", { position: { x: 100, y: 0 }, battery: 0.9, linkSilentS: 25 }, cfg).action, "return_to_base");
  assert.equal(evaluate("DAEMON", { position: { x: 2100, y: 0 }, battery: 0.9, linkSilentS: 0 }, cfg).action, "return_to_base");
  assert.equal(evaluate("DAEMON", { position: { x: 100, y: 0 }, altM: 140, battery: 0.9, linkSilentS: 0 }, cfg).action, "return_to_base");
  // Just enough for home + reserve → return; not enough even without reserve → land.
  assert.equal(evaluate("DAEMON", { position: { x: 1000, y: 0 }, battery: 0.21, linkSilentS: 0 }, cfg).action, "return_to_base");
  const crit = evaluate("DAEMON", { position: { x: 1900, y: 0 }, battery: 0.01, linkSilentS: 30 }, cfg);
  assert.equal(crit.action, "land_now");
  assert.ok(crit.reasons.length >= 2);
  assert.equal(evaluate("SLUG", { position: { x: 1900, y: 0 }, battery: 0.0, linkSilentS: 0 }, cfg).action, "hold");
});

test("POLLEN coverage shares lanes in contiguous blocks and checks every route", () => {
  const plan = planCoverage({
    area: { x0: 0, y0: 0, x1: 100, y1: 200 },
    swathM: 10,
    units: ["p1", "p2", "p3"],
    home: HOME,
    fence: FENCE,
    altM: 30,
  });
  assert.equal(plan.lanes, 10);
  assert.deepEqual(plan.units.map((u) => u.lanes), [[0, 1, 2, 3], [4, 5, 6], [7, 8, 9]]);
  assert.deepEqual(plan.units[0]!.waypoints.slice(0, 4).map((w) => [w.x, w.y]), [[5, 0], [5, 200], [15, 200], [15, 0]]);
  assert.equal(plan.flyable, true);

  const big = planCoverage({ area: { x0: 0, y0: 0, x1: 1500, y1: 1500 }, swathM: 10, units: ["p1"], home: HOME, fence: FENCE, altM: 30 });
  assert.equal(big.flyable, false, "a block too long for one battery is reported");
});

test("Flower charges the lowest battery first on the soonest-free pad", () => {
  const slots = scheduleDocking(
    [{ unit: "a", battery: 0.5 }, { unit: "b", battery: 0.1 }, { unit: "c", battery: 0.3 }, { unit: "d", battery: 1 }],
    2,
    0.05,
  );
  assert.deepEqual(slots, [
    { unit: "b", pad: 0, startMin: 0, readyMin: 18 },
    { unit: "c", pad: 1, startMin: 0, readyMin: 14 },
    { unit: "a", pad: 1, startMin: 14, readyMin: 24 },
  ]);
  assert.throws(() => scheduleDocking([], 0, 0.1));
});
