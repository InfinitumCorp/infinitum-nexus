import { readFileSync } from "node:fs";
export const reference = JSON.parse(
  readFileSync(new URL("./reference-vectors.json", import.meta.url), "utf8"),
);
export const tle = reference.cases[0] as { line1: string; line2: string };
export const omm = {
  OBJECT_NAME: "Offline example",
  OBJECT_ID: "2026-001A",
  EPOCH: "2026-11-07T00:00:00.123",
  MEAN_MOTION: 15.5,
  ECCENTRICITY: 0.001,
  INCLINATION: 51.6,
  RA_OF_ASC_NODE: 30,
  ARG_OF_PERICENTER: 60,
  MEAN_ANOMALY: 90,
  EPHEMERIS_TYPE: 0,
  CLASSIFICATION_TYPE: "U",
  NORAD_CAT_ID: 25544,
  ELEMENT_SET_NO: 1,
  REV_AT_EPOCH: 1,
  BSTAR: 0.0001,
  MEAN_MOTION_DOT: 0,
  MEAN_MOTION_DDOT: 0,
};
