import {
  twoline2satrec,
  json2satrec,
  sgp4,
  eciToGeodetic,
  gstime,
} from "satellite.js";
import type { OMMJsonObject, SatRec } from "satellite.js";
import { invalid, record, number, integer, utc } from "./validation.ts";
interface BaseOrbit {
  catalogId: string;
  epoch: string;
  epochJulian: number;
}
export type Orbit = BaseOrbit &
  (
    | { format: "tle"; line1: string; line2: string }
    | { format: "omm"; omm: OMMJsonObject }
  );
export interface OrbitalState {
  frame: "TEME";
  model: "SGP4";
  simulationOnly: true;
  at: string;
  minutesSinceEpoch: number;
  positionKm: { x: number; y: number; z: number };
  velocityKmS: { x: number; y: number; z: number };
  geodetic: { latitudeDeg: number; longitudeDeg: number; heightKm: number };
}
const degrees = 180 / Math.PI;
function checksum(line: string) {
  let value = 0;
  for (const c of line.slice(0, 68))
    value += c === "-" ? 1 : /[0-9]/.test(c) ? Number(c) : 0;
  return value % 10;
}
function base(s: SatRec): BaseOrbit {
  if (s.error || !Number.isFinite(s.jdsatepoch))
    return invalid("Orbital initialization failed");
  return {
    catalogId: String(Number(s.satnum)),
    epoch: new Date(
      Math.round((s.jdsatepoch - 2440587.5) * 86400000),
    ).toISOString(),
    epochJulian: s.jdsatepoch,
  };
}
export function parseTle(line1: unknown, line2: unknown): Orbit {
  if (typeof line1 !== "string" || typeof line2 !== "string")
    return invalid("Two TLE strings required");
  for (const [line, prefix] of [
    [line1, "1 "],
    [line2, "2 "],
  ]) {
    if (
      line!.length !== 69 ||
      !line!.startsWith(prefix!) ||
      !/^[ -~]+$/.test(line!) ||
      !/^\d$/.test(line![68]!) ||
      checksum(line!) !== Number(line![68])
    )
      return invalid("TLE format/checksum mismatch");
  }
  if (
    ![8, 17, 32, 43, 52, 61, 63].every((i) => line1[i] === " ") ||
    ![7, 16, 25, 33, 42, 51].every((i) => line2[i] === " ") ||
    !/^[ A-Z0-9]{8}$/.test(line1.slice(9, 17)) ||
    !/^ *\d{1,4}$/.test(line1.slice(64, 68))
  )
    return invalid("Invalid TLE column layout");
  if (
    !/^\d{5}$/.test(line1.slice(2, 7)) ||
    line1.slice(2, 7) !== line2.slice(2, 7) ||
    Number(line1.slice(2, 7)) === 0 ||
    line1[7] !== "U"
  )
    return invalid("Matching unclassified numeric TLE catalog IDs required");
  if (!/^\d{2}\d{3}\.\d{8}$/.test(line1.slice(18, 32)))
    return invalid("Invalid TLE epoch");
  const yy = Number(line1.slice(18, 20)),
    year = yy < 57 ? yy + 2000 : yy + 1900,
    day = Number(line1.slice(20, 32));
  const days = (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86400000;
  if (day < 1 || day >= days + 1) return invalid("Invalid TLE epoch day");
  if (
    !/^[ +-]\.\d{8}$/.test(line1.slice(33, 43)) ||
    ![line1.slice(44, 52), line1.slice(53, 61)].every((s) =>
      /^[ +-]\d{5}[+-]\d$/.test(s),
    ) ||
    line1[62] !== "0"
  )
    return invalid("Unsupported TLE derivative/ephemeris format");
  const angular = [
    line2.slice(8, 16),
    line2.slice(17, 25),
    line2.slice(34, 42),
    line2.slice(43, 51),
  ];
  angular.forEach((v, i) => {
    if (!/^ *\d{1,3}\.\d{4}$/.test(v)) invalid("Invalid TLE angle");
    number(v.trim(), 0, i === 0 ? 180 : 359.9999);
  });
  if (
    !/^\d{7}$/.test(line2.slice(26, 33)) ||
    !/^ *\d{1,2}\.\d{8}$/.test(line2.slice(52, 63)) ||
    !/^ *\d+$/.test(line2.slice(63, 68))
  )
    return invalid("Invalid TLE elements");
  number(Number("0." + line2.slice(26, 33)), 0, 0.9999999);
  number(line2.slice(52, 63).trim(), 0.001, 20);
  const sat = twoline2satrec(line1, line2);
  return Object.freeze({ format: "tle", line1, line2, ...base(sat) });
}
export function parseOmm(input: unknown): Orbit {
  const row = record(input);
  for (const [key, expected] of [
    ["CCSDS_OMM_VERS", "3.0"],
    ["CENTER_NAME", "EARTH"],
    ["REF_FRAME", "TEME"],
    ["TIME_SYSTEM", "UTC"],
    ["MEAN_ELEMENT_THEORY", "SGP4"],
    ["CLASSIFICATION_TYPE", "U"],
  ])
    if (row[key!] !== undefined && row[key!] !== expected)
      invalid("Unsupported OMM convention");
  if (
    typeof row.OBJECT_NAME !== "string" ||
    row.OBJECT_NAME.length > 120 ||
    typeof row.OBJECT_ID !== "string" ||
    row.OBJECT_ID.length > 64
  )
    return invalid("OMM object metadata required");
  const epoch = utc(row.EPOCH, true);
  integer(row.EPHEMERIS_TYPE ?? 0, 0, 0);
  const omm: OMMJsonObject = {
    CCSDS_OMM_VERS: "3.0",
    CENTER_NAME: "EARTH",
    REF_FRAME: "TEME",
    TIME_SYSTEM: "UTC",
    MEAN_ELEMENT_THEORY: "SGP4",
    OBJECT_NAME: row.OBJECT_NAME,
    OBJECT_ID: row.OBJECT_ID,
    EPOCH: epoch,
    CLASSIFICATION_TYPE: "U",
    NORAD_CAT_ID: integer(row.NORAD_CAT_ID, 1, 999999999),
    EPHEMERIS_TYPE: 0,
    ELEMENT_SET_NO: integer(row.ELEMENT_SET_NO ?? 0, 0, 999999),
    REV_AT_EPOCH: integer(row.REV_AT_EPOCH ?? 0, 0, 999999999),
    MEAN_MOTION: number(row.MEAN_MOTION, 0.001, 20),
    ECCENTRICITY: number(row.ECCENTRICITY, 0, 0.9999999),
    INCLINATION: number(row.INCLINATION, 0, 180),
    RA_OF_ASC_NODE: number(row.RA_OF_ASC_NODE, 0, 359.999999999),
    ARG_OF_PERICENTER: number(row.ARG_OF_PERICENTER, 0, 359.999999999),
    MEAN_ANOMALY: number(row.MEAN_ANOMALY, 0, 359.999999999),
    BSTAR: number(row.BSTAR ?? 0, -1, 1),
    MEAN_MOTION_DOT: number(row.MEAN_MOTION_DOT ?? 0, -10, 10),
    MEAN_MOTION_DDOT: number(row.MEAN_MOTION_DDOT ?? 0, -10, 10),
  };
  const sat = json2satrec(omm);
  return Object.freeze({
    format: "omm",
    omm: Object.freeze(omm),
    ...base(sat),
    epoch,
  });
}
export function restoreOrbit(input: unknown): Orbit {
  const row = record(input);
  if (row.format === "tle") return parseTle(row.line1, row.line2);
  if (row.format === "omm") return parseOmm(row.omm);
  return invalid("Stored orbital format required");
}
function fresh(orbit: Orbit) {
  return orbit.format === "tle"
    ? twoline2satrec(orbit.line1, orbit.line2)
    : json2satrec(orbit.omm);
}
export function propagateMinutes(orbit: Orbit, minutes: number): OrbitalState {
  number(minutes, -10080, 10080);
  const sat = fresh(orbit),
    state = sgp4(sat, minutes);
  if (
    !state ||
    sat.error ||
    ![...Object.values(state.position), ...Object.values(state.velocity)].every(
      Number.isFinite,
    )
  )
    return invalid("SGP4 propagation failed");
  const at = new Date(
    Math.round((orbit.epochJulian - 2440587.5) * 86400000 + minutes * 60000),
  ).toISOString();
  const geo = eciToGeodetic(state.position, gstime(new Date(at)));
  if (!Object.values(geo).every(Number.isFinite))
    return invalid("Coordinate conversion failed");
  return {
    frame: "TEME",
    model: "SGP4",
    simulationOnly: true,
    at,
    minutesSinceEpoch: minutes,
    positionKm: { ...state.position },
    velocityKmS: { ...state.velocity },
    geodetic: {
      latitudeDeg: geo.latitude * degrees,
      longitudeDeg: geo.longitude * degrees,
      heightKm: geo.height,
    },
  };
}
export function propagateAt(orbit: Orbit, time: string): OrbitalState {
  const at = utc(time),
    minutes =
      (Date.parse(at) - (orbit.epochJulian - 2440587.5) * 86400000) / 60000;
  return { ...propagateMinutes(orbit, minutes), at };
}
