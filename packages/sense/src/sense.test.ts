import assert from "node:assert/strict";
import test from "node:test";
import { consentedSample } from "./gather.ts";
import { faceIdentity, redactFaces } from "./vision.ts";
import { parseSafetyCommand } from "./voice.ts";
import { geohash, haversineM, wgsToLocal } from "./wgs.ts";

test("haversine matches the London to Paris distance", () => {
  const metres = haversineM({ lat: 51.5074, lon: -0.1278 }, { lat: 48.8566, lon: 2.3522 });
  assert.ok(Math.abs(metres - 343_560) < 2_000);
});

test("local frame points east and north", () => {
  const origin = { lat: 51.5, lon: -0.12 };
  const east = wgsToLocal(origin, { lat: 51.5, lon: -0.11 });
  const north = wgsToLocal(origin, { lat: 51.51, lon: -0.12 });
  assert.ok(east.x > 500 && Math.abs(east.y) < 1);
  assert.ok(north.y > 1_000 && Math.abs(north.x) < 1);
});

test("geohash of the published example", () => {
  assert.equal(geohash({ lat: 57.64911, lon: 10.40744 }, 8), "u4pruydq");
});

test("voice only accepts a safer command", () => {
  assert.equal(parseSafetyCommand("Land now."), "land_now");
  assert.equal(parseSafetyCommand("return home"), "return_to_base");
  assert.equal(parseSafetyCommand("hold"), "hold");
  assert.equal(parseSafetyCommand("arm and fly to the tower"), null);
});

test("face identity and sensor samples need consent", () => {
  assert.equal(redactFaces([{ x: 0, y: 0, width: 1, height: 1 }]).redactions, 1);
  assert.throws(() => faceIdentity("  "), /consent/);
  assert.equal(faceIdentity("owner-ok").allowed, true);
  assert.throws(() => consentedSample("", "geo", 1), /consent/);
});
