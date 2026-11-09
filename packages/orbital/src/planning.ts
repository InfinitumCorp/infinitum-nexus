import { eciToEcf, ecfToLookAngles, gstime } from "satellite.js";
import { propagateAt } from "./orbit.ts";
import type { Orbit } from "./orbit.ts";
import {
  record,
  exact,
  id,
  number,
  integer,
  utc,
  invalid,
} from "./validation.ts";
export interface Station {
  id: string;
  latitudeDeg: number;
  longitudeDeg: number;
  heightM: number;
  minElevationDeg: number;
}
export interface Pass {
  id: string;
  start: string;
  end: string;
  peakAt: string;
  maxElevationDeg: number;
  rangeAtPeakKm: number;
  startAzimuthDeg: number;
  endAzimuthDeg: number;
  clippedStart: boolean;
  clippedEnd: boolean;
}
export function validateStation(input: unknown): Station {
  const s = record(input);
  exact(s, ["id", "latitudeDeg", "longitudeDeg", "heightM", "minElevationDeg"]);
  return {
    id: id(s.id),
    latitudeDeg: number(s.latitudeDeg, -90, 90),
    longitudeDeg: number(s.longitudeDeg, -180, 180),
    heightM: number(s.heightM, -500, 10000),
    minElevationDeg: number(s.minElevationDeg, 0, 85),
  };
}
/** Offline sampling, not operational antenna guidance. Narrow/grazing passes may be missed. */
export function predictPasses(orbit: Orbit, input: unknown) {
  const o = record(input);
  exact(o, ["station", "start", "end", "stepSeconds"]);
  const station = validateStation(o.station),
    start = utc(o.start),
    end = utc(o.end),
    a = Date.parse(start),
    b = Date.parse(end),
    step = integer(o.stepSeconds ?? 30, 5, 120) * 1000;
  if (b <= a || b - a > 86400000 || Math.ceil((b - a) / step) + 1 > 4096)
    invalid("Unsupported pass window or sample budget");
  const epoch = (orbit.epochJulian - 2440587.5) * 86400000;
  if (Math.max(Math.abs(a - epoch), Math.abs(b - epoch)) > 7 * 86400000)
    invalid("Pass window outside element-age limit");
  const observer = {
    latitude: (station.latitudeDeg * Math.PI) / 180,
    longitude: (station.longitudeDeg * Math.PI) / 180,
    height: station.heightM / 1000,
  };
  let evaluations = 0;
  const iso = (ms: number) => new Date(Math.round(ms)).toISOString();
  function look(ms: number) {
    if (++evaluations > 8192) invalid("Pass refinement budget exceeded");
    const at = iso(ms),
      state = propagateAt(orbit, at),
      angle = ecfToLookAngles(
        observer,
        eciToEcf(state.positionKm, gstime(new Date(at))),
      );
    const value = {
      time: ms,
      elevation: (angle.elevation * 180) / Math.PI,
      azimuth: (angle.azimuth * 180) / Math.PI,
      range: angle.rangeSat,
    };
    if (![value.elevation, value.azimuth, value.range].every(Number.isFinite))
      invalid("Invalid look angle");
    return value;
  }
  function crossing(lo: number, hi: number, rising: boolean) {
    for (let i = 0; i < 16 && hi - lo > 500; i++) {
      const mid = (lo + hi) / 2,
        up = look(mid).elevation >= station.minElevationDeg;
      if (up === rising) hi = mid;
      else lo = mid;
    }
    return (lo + hi) / 2;
  }
  const samples = [look(a)];
  for (let t = a + step; t < b; t += step) samples.push(look(t));
  samples.push(look(b));
  const intervals: {
    a: number;
    b: number;
    clippedStart: boolean;
    clippedEnd: boolean;
  }[] = [];
  let opening =
      samples[0]!.elevation >= station.minElevationDeg ? a : undefined,
    clipped = opening !== undefined;
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1]!,
      current = samples[i]!,
      was = prev.elevation >= station.minElevationDeg,
      up = current.elevation >= station.minElevationDeg;
    if (!was && up) {
      opening = crossing(prev.time, current.time, true);
      clipped = false;
    }
    if (was && !up && opening !== undefined) {
      intervals.push({
        a: opening,
        b: crossing(prev.time, current.time, false),
        clippedStart: clipped,
        clippedEnd: false,
      });
      opening = undefined;
    }
  }
  if (opening !== undefined)
    intervals.push({ a: opening, b, clippedStart: clipped, clippedEnd: true });
  if (intervals.length > 64) invalid("Too many passes");
  const passes: Pass[] = intervals
    .filter((p) => p.b - p.a >= 1)
    .map((p, index) => {
      const inside = samples.filter((s) => s.time >= p.a && s.time <= p.b);
      inside.push(look(p.a), look(p.b));
      let peak = inside.reduce((best, x) =>
        x.elevation > best.elevation ? x : best,
      );
      let lo = Math.max(p.a, peak.time - step),
        hi = Math.min(p.b, peak.time + step);
      for (let j = 0; j < 20 && hi - lo > 100; j++) {
        const left = look(lo + (hi - lo) / 3),
          right = look(hi - (hi - lo) / 3);
        if (left.elevation > peak.elevation) peak = left;
        if (right.elevation > peak.elevation) peak = right;
        if (left.elevation < right.elevation) lo = left.time;
        else hi = right.time;
      }
      const aos = look(p.a),
        los = look(p.b);
      return {
        id: `p${index}`,
        start: iso(p.a),
        end: iso(p.b),
        peakAt: iso(peak.time),
        maxElevationDeg: peak.elevation,
        rangeAtPeakKm: peak.range,
        startAzimuthDeg: aos.azimuth,
        endAzimuthDeg: los.azimuth,
        clippedStart: p.clippedStart,
        clippedEnd: p.clippedEnd,
      };
    });
  return {
    simulationOnly: true as const,
    requiresOperatorReview: true as const,
    catalogId: orbit.catalogId,
    elementEpoch: orbit.epoch,
    station,
    start,
    end,
    stepSeconds: step / 1000,
    crossingToleranceSeconds: 0.5,
    evaluations,
    passes,
  };
}
export interface Contact {
  id: string;
  stationId: string;
  satelliteId: string;
  start: string;
  end: string;
  priority: number;
}
function contact(input: unknown): Contact {
  const c = record(input);
  exact(c, ["id", "stationId", "satelliteId", "start", "end", "priority"]);
  const result = {
    id: id(c.id),
    stationId: id(c.stationId),
    satelliteId: id(c.satelliteId),
    start: utc(c.start),
    end: utc(c.end),
    priority: integer(c.priority ?? 0, 0, 100),
  };
  const duration = Date.parse(result.end) - Date.parse(result.start);
  if (duration <= 0 || duration > 86400000) invalid("Invalid contact interval");
  return result;
}
/** Deterministic greedy proposals only: not optimal, visibility-verified or externally reserved. */
export function scheduleContacts(input: unknown, options: unknown = {}) {
  const o = record(options);
  exact(o, ["turnaroundSeconds", "existing"]);
  const guard = integer(o.turnaroundSeconds ?? 0, 0, 3600) * 1000;
  const rawExisting = o.existing ?? [];
  if (
    !Array.isArray(input) ||
    input.length > 128 ||
    !Array.isArray(rawExisting) ||
    rawExisting.length > 128
  )
    invalid("Contact request capacity exceeded");
  const existing = (rawExisting as unknown[]).map(contact),
    requests = (input as unknown[]).map(contact),
    all = [...existing, ...requests];
  if (new Set(all.map((x) => x.id)).size !== all.length)
    invalid("Duplicate contact identifier");
  if (
    all.length &&
    Math.max(...all.map((x) => Date.parse(x.end))) -
      Math.min(...all.map((x) => Date.parse(x.start))) >
      7 * 86400000
  )
    invalid("Contact horizon exceeds seven days");
  const overlaps = (a: Contact, b: Contact) =>
    (a.stationId === b.stationId || a.satelliteId === b.satelliteId) &&
    Date.parse(a.start) < Date.parse(b.end) + guard &&
    Date.parse(b.start) < Date.parse(a.end) + guard;
  for (let i = 0; i < existing.length; i++)
    if (existing.slice(0, i).some((x) => overlaps(x, existing[i]!)))
      invalid("Conflicting fixed reservations");
  const ascii = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  requests.sort(
    (a, b) =>
      b.priority - a.priority ||
      Date.parse(a.start) - Date.parse(b.start) ||
      ascii(a.id, b.id),
  );
  const accepted: Contact[] = [],
    rejected: {
      id: string;
      reason: "resource_conflict";
      conflicts: string[];
    }[] = [];
  for (const request of requests) {
    const conflicts = [...existing, ...accepted]
      .filter((x) => overlaps(x, request))
      .map((x) => x.id)
      .sort();
    if (conflicts.length)
      rejected.push({ id: request.id, reason: "resource_conflict", conflicts });
    else accepted.push(request);
  }
  accepted.sort(
    (a, b) => Date.parse(a.start) - Date.parse(b.start) || ascii(a.id, b.id),
  );
  return {
    simulationOnly: true as const,
    requiresOperatorReview: true as const,
    visibilityVerified: false as const,
    externalReservation: false as const,
    algorithm: "priority-first-greedy",
    turnaroundSeconds: guard / 1000,
    existing,
    accepted,
    rejected,
  };
}
/** Free-space illustration only, no weather, terrain, interference, pointing or equipment model. */
export function linkBudget(input: unknown) {
  const o = record(input);
  exact(o, [
    "distanceKm",
    "frequencyHz",
    "txPowerDbm",
    "txGainDbi",
    "rxGainDbi",
    "txLossDb",
    "rxLossDb",
    "otherLossDb",
    "bandwidthHz",
    "noiseTemperatureK",
    "requiredSnrDb",
  ]);
  const inputs = {
    distanceKm: number(o.distanceKm, 0.001, 1e7),
    frequencyHz: number(o.frequencyHz, 1e6, 1e12),
    txPowerDbm: number(o.txPowerDbm, -200, 100),
    txGainDbi: number(o.txGainDbi, -100, 100),
    rxGainDbi: number(o.rxGainDbi, -100, 100),
    txLossDb: number(o.txLossDb ?? 0, 0, 300),
    rxLossDb: number(o.rxLossDb ?? 0, 0, 300),
    otherLossDb: number(o.otherLossDb ?? 0, 0, 300),
    bandwidthHz: number(o.bandwidthHz, 1, 1e10),
    noiseTemperatureK: number(o.noiseTemperatureK ?? 290, 1, 1e5),
    requiredSnrDb: number(o.requiredSnrDb, -100, 100),
  };
  const freeSpaceLossDb =
      20 *
      Math.log10(
        (4 * Math.PI * inputs.distanceKm * 1000 * inputs.frequencyHz) /
          299792458,
      ),
    eirpDbm = inputs.txPowerDbm + inputs.txGainDbi - inputs.txLossDb;
  const receivedPowerDbm =
      eirpDbm +
      inputs.rxGainDbi -
      inputs.rxLossDb -
      inputs.otherLossDb -
      freeSpaceLossDb,
    noisePowerDbm =
      10 *
        Math.log10(
          1.380649e-23 * inputs.noiseTemperatureK * inputs.bandwidthHz,
        ) +
      30,
    snrDb = receivedPowerDbm - noisePowerDbm;
  return {
    simulationOnly: true as const,
    requiresOperatorReview: true as const,
    freeSpaceOnly: true as const,
    inputs,
    freeSpaceLossDb,
    eirpDbm,
    receivedPowerDbm,
    noisePowerDbm,
    snrDb,
    marginDb: snrDb - inputs.requiredSnrDb,
  };
}
