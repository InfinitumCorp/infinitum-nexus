import { test } from "node:test";
import assert from "node:assert/strict";
import { FusionEngine, type Detection, type Sensor } from "./fusion.ts";
import { initState, predict, update } from "./kalman.ts";

const SENSORS: Sensor[] = [
  { id: "radar-1", kind: "radar", sigmaM: 5 },
  { id: "eoir-1", kind: "eo_ir", sigmaM: 2 },
];

/** Deterministic noise so tests don't flake. */
function noise(i: number): number {
  return Math.sin(i * 12.9898) * 1.5;
}

test("kalman update pulls state toward the measurement and shrinks covariance", () => {
  const s = initState(0, 0, 25);
  const u = update(s, 10, 0, 4);
  assert.ok(u.x[0] > 5 && u.x[0] < 10);
  assert.ok(u.P[0][0] < s.P[0][0]);
  const p = predict(u, 1, 1);
  assert.ok(p.P[0][0] > u.P[0][0]);
});

test("one moving target seen by two sensors fuses into one confirmed track", () => {
  const engine = new FusionEngine(SENSORS);
  // Target moving east at 10 m/s.
  for (let k = 0; k < 10; k++) {
    const t = k;
    engine.ingest([
      { sensorId: "radar-1", t, x: 10 * t + noise(k), y: 100 + noise(k + 50), label: "vehicle" },
      { sensorId: "eoir-1", t, x: 10 * t + noise(k + 7) / 2, y: 100 + noise(k + 90) / 2, label: "vehicle" },
    ]);
  }
  const pic = engine.picture();
  assert.equal(pic.length, 1);
  const track = pic[0]!;
  assert.equal(track.status, "confirmed");
  assert.deepEqual(track.sensors, ["eoir-1", "radar-1"]);
  assert.equal(track.label, "vehicle");
  assert.ok(Math.abs(track.velocity[0] - 10) < 1.5, `vx ${track.velocity[0]}`);
  assert.ok(Math.abs(track.headingDeg - 90) < 10, `heading ${track.headingDeg}`);
  assert.ok(track.sigmaM < 5);
});

test("two separated targets stay two tracks", () => {
  const engine = new FusionEngine(SENSORS);
  for (let t = 0; t < 5; t++) {
    engine.ingest([
      { sensorId: "radar-1", t, x: 5 * t, y: 0 },
      { sensorId: "radar-1", t, x: 5 * t, y: 500 },
    ]);
  }
  assert.equal(engine.picture().length, 2);
});

test("tentative clutter is hidden and dropped after one miss", () => {
  const engine = new FusionEngine(SENSORS);
  engine.ingest([{ sensorId: "radar-1", t: 0, x: 900, y: 900 }]);
  assert.equal(engine.picture().length, 0);
  assert.equal(engine.picture({ includeTentative: true }).length, 1);
  engine.ingest([{ sensorId: "radar-1", t: 1, x: -900, y: -900 }]);
  assert.ok(engine.dropped.includes("ARG-0001"));
});

test("confirmed tracks coast through gaps and drop after repeated misses", () => {
  const engine = new FusionEngine(SENSORS, { dropAfterMisses: 2 });
  const far = (t: number): Detection => ({ sensorId: "radar-1", t, x: 10_000 + t, y: 10_000 });
  for (let t = 0; t < 4; t++) engine.ingest([{ sensorId: "radar-1", t, x: 10 * t, y: 0 }, far(t)]);
  engine.ingest([far(4)]);
  const coasting = engine.picture().find((p) => p.position[1] < 100);
  assert.equal(coasting?.status, "coasting");
  assert.ok(Math.abs(coasting!.position[0] - 40) < 5, "coasting track is predicted forward");
  engine.ingest([far(5)]);
  assert.equal(engine.picture().filter((p) => p.position[1] < 100).length, 0);
});

test("unknown sensors are rejected", () => {
  const engine = new FusionEngine(SENSORS);
  assert.throws(() => engine.ingest([{ sensorId: "ghost", t: 0, x: 0, y: 0 }]), /unknown sensor/);
});
