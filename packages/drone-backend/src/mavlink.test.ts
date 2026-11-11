import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeTelemetry } from "./mavlink.ts";

import { crc, frame } from "./fixtures.ts";
test("CRC oracle has standard MCRF4XX check value", () => assert.equal(crc(Buffer.from("123456789")), 0x6f91));
test("heartbeat v1 and v2 normalize source and mode without executing it", () => {
  for (const v2 of [false, true]) {
    const [value] = decodeTelemetry(frame(0, undefined, v2));
    assert.equal(value!.kind, "heartbeat"); assert.equal(value!.systemId, 1);
    assert.equal(value!.componentId, 1); assert.equal(value!.sequence, 7);
    assert.equal(value!.data.armed, true);
    assert.equal(value!.data.stack, "ardupilot");
  }
  const px4 = Buffer.from("00000000020cd10403", "hex");
  assert.equal(decodeTelemetry(frame(0, px4))[0]!.data.stack, "px4");
});
test("position uses WGS84 degrees, MSL/relative altitude metres and NED velocities", () => {
  const p = Buffer.alloc(28); p.writeUInt32LE(1234); p.writeInt32LE(551234567, 4); p.writeInt32LE(371234567, 8);
  p.writeInt32LE(123456, 12); p.writeInt32LE(4567, 16); p.writeInt16LE(-123, 20); p.writeInt16LE(234, 22); p.writeInt16LE(12, 24); p.writeUInt16LE(65535, 26);
  const data = decodeTelemetry(frame(33, p))[0]!.data;
  assert.equal(data.latDeg, 55.1234567); assert.equal(data.lonDeg, 37.1234567);
  assert.equal(data.altitudeMslM, 123.456); assert.equal(data.relativeAltitudeM, 4.567);
  assert.equal(data.northMs, -1.23); assert.equal(data.headingDeg, null);
});
test("v2 trailing zeros are restored and SYS_STATUS unknown sentinels stay null", () => {
  assert.equal(decodeTelemetry(frame(33, Buffer.from([1]), true))[0]!.data.latDeg, 0);
  const p = Buffer.alloc(31); p.writeUInt16LE(65535, 14); p.writeInt16LE(-1, 16); p.writeInt8(-1, 30);
  const data = decodeTelemetry(frame(1, p))[0]!.data;
  assert.equal(data.voltageV, null); assert.equal(data.currentA, null); assert.equal(data.batteryPct, null);
});
test("signed or unknown-incompatibility packets are refused, never treated as authenticated", () => {
  for (const flag of [1, 2, 128]) assert.throws(() => decodeTelemetry(frame(0, undefined, true, flag)), /flags/);
});
test("bad CRC, unknown ids, incomplete frames, noise and invalid lengths fail closed", () => {
  const broken = frame(); broken[8] ^= 1;
  for (const value of [broken, frame(2), frame().subarray(0, 10), Buffer.from([0]), frame(0, Buffer.alloc(8)), frame(0, Buffer.alloc(10), true)]) assert.throws(() => decodeTelemetry(value));
});
test("zero source ids, invalid coordinates and battery ranges are rejected", () => {
  const source = frame(); source[3] = 0; assert.throws(() => decodeTelemetry(source));
  const p = Buffer.alloc(28); p.writeInt32LE(910000000, 4); assert.throws(() => decodeTelemetry(frame(33, p)));
  const battery = Buffer.alloc(31); battery.writeInt8(101, 30); assert.throws(() => decodeTelemetry(frame(1, battery)));
});
test("bounded datagrams decode concatenated frames but reject empty and over-capacity inputs", () => {
  assert.equal(decodeTelemetry(Buffer.concat([frame(), frame()])).length, 2);
  assert.throws(() => decodeTelemetry(Buffer.alloc(0)));
  assert.throws(() => decodeTelemetry(Buffer.alloc(32769)));
  assert.throws(() => decodeTelemetry(Buffer.concat(Array.from({length: 65}, () => frame()))));
});
