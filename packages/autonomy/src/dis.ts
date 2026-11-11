import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const dis = require(join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../third_party/open-dis/dis6.js",
)) as {
  EntityStatePdu: new () => EntityState;
  CoordinateConversion: new () => {
    getXYZfromLatLonAltDegrees(p: { lat: number; lon: number; alt: number }): { x: number; y: number; z: number };
    convertDisToLatLongInDegrees(p: { x: number; y: number; z: number }): { latitude: number; longitude: number; altitude: number };
  };
  OutputStream: new (buffer: ArrayBuffer) => { toByteArray(): ArrayBuffer };
  InputStream: new (buffer: ArrayBuffer) => unknown;
};

interface EntityState {
  pduLength: number;
  exerciseID: number;
  forceId: number;
  pduType: number;
  entityID: { site: number; application: number; entity: number };
  marking: { setMarking(value: string): void; getMarking(): string };
  entityLocation: { x: number; y: number; z: number };
  encodeToBinary(out: unknown): void;
  initFromBinary(input: unknown): void;
}

export interface EntityFix {
  marking: string;
  lat: number;
  lon: number;
  altM: number;
}

const ENTITY_STATE_BYTES = 144;

/** Own-ship position as an IEEE 1278.1 entity state. Not a fire, detonation, or designator. */
export function entityState(fix: EntityFix): Uint8Array {
  const pdu = new dis.EntityStatePdu();
  pdu.pduLength = ENTITY_STATE_BYTES;
  pdu.exerciseID = 1;
  pdu.forceId = 0;
  pdu.entityID.site = 1;
  pdu.entityID.application = 1;
  pdu.entityID.entity = 1;
  pdu.marking.setMarking(fix.marking);
  const xyz = new dis.CoordinateConversion().getXYZfromLatLonAltDegrees({
    lat: fix.lat,
    lon: fix.lon,
    alt: fix.altM,
  });
  pdu.entityLocation.x = xyz.x;
  pdu.entityLocation.y = xyz.y;
  pdu.entityLocation.z = xyz.z;
  const out = new dis.OutputStream(new ArrayBuffer(ENTITY_STATE_BYTES));
  pdu.encodeToBinary(out);
  return new Uint8Array(out.toByteArray());
}

export function readEntityState(bytes: Uint8Array): EntityFix {
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const pdu = new dis.EntityStatePdu();
  pdu.initFromBinary(new dis.InputStream(copy));
  if (pdu.pduType !== 1) throw new Error("Only an entity-state PDU can be read here.");
  const geo = new dis.CoordinateConversion().convertDisToLatLongInDegrees(pdu.entityLocation);
  return {
    marking: pdu.marking.getMarking().replace(/\0+$/g, ""),
    lat: geo.latitude,
    lon: geo.longitude,
    altM: geo.altitude,
  };
}
