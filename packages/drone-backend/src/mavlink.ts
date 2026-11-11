/** Receive-only subset of the published MAVLink wire protocol; no vehicle commands.
 * Independent implementation, not copied/generated from an upstream codebase.
 * CRC detects corruption, NOT sender authenticity. Use a trusted authenticated gateway.
 */
export interface Observation {
  kind: "heartbeat" | "systemStatus" | "globalPosition";
  systemId: number;
  componentId: number;
  sequence: number;
  data: Record<string, number | string | boolean | null>;
}
const definitions: Record<number, { extra: number; min: number; max: number }> = {
  0: { extra: 50, min: 9, max: 9 },
  1: { extra: 124, min: 31, max: 43 },
  33: { extra: 104, min: 28, max: 28 },
};
function checksum(bytes: Uint8Array, extra: number) {
  let value = 0xffff;
  const add = (byte: number) => {
    let tmp = byte ^ (value & 255); tmp ^= (tmp << 4) & 255;
    value = ((value >>> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >>> 4)) & 65535;
  };
  for (const byte of bytes) add(byte);
  add(extra); return value;
}
export function decodeTelemetry(bytes: Uint8Array): Observation[] {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 32768) throw new Error("Telemetry datagram must be 1–32768 bytes");
  const frames: Observation[] = [];
  for (let offset = 0; offset < bytes.length;) {
    if (frames.length >= 64) throw new Error("At most 64 frames per datagram");
    const magic = bytes[offset]; const v2 = magic === 0xfd;
    if (magic !== 0xfe && !v2) throw new Error("Invalid MAVLink marker");
    const header = v2 ? 10 : 6;
    if (bytes.length - offset < header + 2) throw new Error("Incomplete MAVLink frame");
    if (v2 && bytes[offset + 2] !== 0) throw new Error("Unsupported MAVLink incompatibility flags (including signatures)");
    const length = bytes[offset + 1]!;
    const total = header + length + 2;
    if (bytes.length - offset < total) throw new Error("Incomplete MAVLink payload");
    const messageId = v2 ? bytes[offset + 7]! | bytes[offset + 8]! << 8 | bytes[offset + 9]! << 16 : bytes[offset + 5]!;
    const definition = definitions[messageId];
    if (!definition) throw new Error("Unsupported MAVLink message");
    if (length > definition.max || (v2 ? length < 1 : length !== definition.min)) throw new Error("Invalid MAVLink payload length");
    const check = offset + header + length;
    if (checksum(bytes.subarray(offset + 1, check), definition.extra) !== (bytes[check]! | bytes[check + 1]! << 8)) throw new Error("MAVLink CRC mismatch");
    const sequence = bytes[offset + (v2 ? 4 : 2)]!;
    const systemId = bytes[offset + (v2 ? 5 : 3)]!;
    const componentId = bytes[offset + (v2 ? 6 : 4)]!;
    if (!systemId || !componentId) throw new Error("MAVLink source ids must be nonzero");
    const payload = new Uint8Array(definition.max); payload.set(bytes.subarray(offset + header, check));
    const p = new DataView(payload.buffer);
    let kind: Observation["kind"]; let data: Observation["data"];
    if (messageId === 0) {
      if (p.getUint8(8) !== 3) throw new Error("Invalid heartbeat protocol version");
      kind = "heartbeat";
      const autopilot = p.getUint8(5);
      const stack = autopilot === 12 ? "px4" : autopilot === 3 ? "ardupilot" : "other";
      data = { customMode: p.getUint32(0, true), vehicleType: p.getUint8(4), autopilot, stack, baseMode: p.getUint8(6), systemStatus: p.getUint8(7), armed: !!(p.getUint8(6) & 128) };
    } else if (messageId === 1) {
      kind = "systemStatus";
      const voltage = p.getUint16(14, true), current = p.getInt16(16, true), battery = p.getInt8(30);
      if (battery < -1 || battery > 100) throw new Error("Invalid battery percentage");
      data = { voltageV: voltage === 65535 ? null : voltage / 1000, currentA: current === -1 ? null : current / 100, batteryPct: battery === -1 ? null : battery };
    } else {
      kind = "globalPosition";
      const lat = p.getInt32(4, true) / 1e7, lon = p.getInt32(8, true) / 1e7, heading = p.getUint16(26, true);
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (heading !== 65535 && heading > 35999)) throw new Error("Invalid position or heading");
      data = { bootMs: p.getUint32(0, true), latDeg: lat, lonDeg: lon, altitudeMslM: p.getInt32(12, true) / 1000, relativeAltitudeM: p.getInt32(16, true) / 1000, northMs: p.getInt16(20, true) / 100, eastMs: p.getInt16(22, true) / 100, downMs: p.getInt16(24, true) / 100, headingDeg: heading === 65535 ? null : heading / 100 };
    }
    frames.push({ kind, sequence, systemId, componentId, data }); offset += total;
  }
  return frames;
}
