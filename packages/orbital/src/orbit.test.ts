import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTle,
  parseOmm,
  restoreOrbit,
  propagateMinutes,
  propagateAt,
} from "./orbit.ts";
import { reference, tle, omm } from "./fixtures.ts";
test("SGP4 matches ten published Vallado near-earth/deep-space/resonant vectors", () => {
  let count = 0;
  for (const c of reference.cases) {
    const orbit = parseTle(c.line1, c.line2);
    for (const vector of c.vectors) {
      const actual = propagateMinutes(orbit, vector.minutes);
      for (const axis of ["x", "y", "z"] as const) {
        assert.ok(
          Math.abs(actual.positionKm[axis] - vector.positionKm[axis]) < 1e-6,
          `${c.catalogId} t=${vector.minutes} position ${axis}`,
        );
        assert.ok(
          Math.abs(actual.velocityKmS[axis] - vector.velocityKmS[axis]) < 1e-8,
          `${c.catalogId} t=${vector.minutes} velocity ${axis}`,
        );
      }
      count++;
    }
  }
  assert.equal(count, 10);
});
test("TLE validation checks exact format, checksum, matching numeric catalog and element ranges", () => {
  const valid = parseTle(tle.line1, tle.line2);
  assert.equal(valid.catalogId, "5");
  for (const [a, b] of [
    [tle.line1.slice(0, 68) + "0", tle.line2],
    [tle.line1, tle.line2 + " tail"],
    [tle.line1.replace("00005", "A0005"), tle.line2],
    [tle.line1.replace("179.78495062", "999.78495062"), tle.line2],
  ])
    assert.throws(() => parseTle(a, b));
});
test("OMM supports explicit Earth/TEME/UTC/SGP4 conventions and refuses unsupported precision/frames", () => {
  const orbit = parseOmm(omm);
  assert.equal(orbit.catalogId, "25544");
  assert.equal(orbit.epoch, "2026-11-07T00:00:00.123Z");
  const state = propagateAt(orbit, orbit.epoch);
  assert.equal(state.frame, "TEME");
  assert.ok(Number.isFinite(state.positionKm.x));
  for (const patch of [
    { REF_FRAME: "GCRF" },
    { CENTER_NAME: "MARS" },
    { TIME_SYSTEM: "TAI" },
    { MEAN_ELEMENT_THEORY: "OTHER" },
    { EPOCH: "2026-11-07T00:00:00.123456Z" },
    { ECCENTRICITY: 1 },
    { MEAN_MOTION: NaN },
    { INCLINATION: 181 },
    { NORAD_CAT_ID: "A0001" },
    { CCSDS_OMM_VERS: "2.0" },
  ])
    assert.throws(() => parseOmm({ ...omm, ...patch }));
});
test("fresh propagation is deterministic regardless of prior calls and limits element-age distance", () => {
  const orbit = parseTle(tle.line1, tle.line2);
  const first = propagateMinutes(orbit, 360);
  propagateMinutes(orbit, -100);
  assert.deepEqual(propagateMinutes(orbit, 360), first);
  assert.throws(() => propagateMinutes(orbit, 10081));
  assert.throws(() => propagateMinutes(orbit, Infinity));
  assert.throws(() => propagateAt(orbit, "not-a-time"));
});

function corrected(line: string) {
  let sum = 0;
  for (const c of line.slice(0, 68))
    sum += c === "-" ? 1 : /[0-9]/.test(c) ? Number(c) : 0;
  return line.slice(0, 68) + String(sum % 10);
}
const change = (line: string, start: number, value: string) =>
  corrected(line.slice(0, start) + value + line.slice(start + value.length));
for (const [name, a, b] of [
  ["catalog mismatch", tle.line1, change(tle.line2, 2, "00006")],
  [
    "Alpha-5 catalog",
    change(tle.line1, 2, "A0005"),
    change(tle.line2, 2, "A0005"),
  ],
  ["epoch calendar rollover", change(tle.line1, 20, "367.00000000"), tle.line2],
  ["inclination range", tle.line1, change(tle.line2, 8, "181.0000")],
  ["nonzero ephemeris type", change(tle.line1, 62, "1"), tle.line2],
  ["column layout", change(tle.line1, 8, "X"), tle.line2],
  ["invalid derivative", change(tle.line1, 44, "INVALID!"), tle.line2],
  ["mean motion range", tle.line1, change(tle.line2, 52, "99.00000000")],
])
  test(`checksum-correct TLE rejects ${name}`, () =>
    assert.throws(() => parseTle(a, b)));
test("OMM rejects invalid UTC calendar dates, leap seconds, offsets and unknown precision", () => {
  for (const EPOCH of [
    "2026-02-30T00:00:00Z",
    "2026-11-07T00:00:60Z",
    "2026-11-07T00:00:00+03:00",
    "2026-11-07T00:00:00.1234Z",
    "2026-11-07",
    "2100-01-01T00:00:00Z",
  ])
    assert.throws(() => parseOmm({ ...omm, EPOCH }));
});
test("stored elements are reparsed instead of trusting caller-authored propagation metadata", () => {
  const orbit = parseOmm(omm),
    forged = {
      ...orbit,
      catalogId: "forged",
      epoch: "1900-01-01",
      epochJulian: 0,
    };
  assert.deepEqual(restoreOrbit(forged), orbit);
  assert.throws(() =>
    restoreOrbit({ format: "untrusted-satrec", position: [0, 0, 0] }),
  );
});
