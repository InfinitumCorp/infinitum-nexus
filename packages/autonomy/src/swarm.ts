/**
 * POLLEN swarm coverage and Flower docking.
 *
 * Coverage: a rectangular survey area is cut into lanes one sensor swath
 * wide. Lanes are shared out in contiguous blocks so units never cross each
 * other, and each unit flies its block back and forth (boustrophedon).
 * Each unit's route is then put through the same pre-launch check as any
 * other mission, so a block too long for one battery is reported, not flown.
 *
 * Docking: Flower has a fixed number of charging pads. Units are charged
 * lowest battery first, each on the pad that frees up soonest.
 */
import { checkMission, type MissionReport, type Waypoint } from "./mission.ts";
import type { Point, Polygon } from "./geo.ts";

export interface SurveyArea {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface CoveragePlan {
  lanes: number;
  units: { unit: string; lanes: number[]; waypoints: Waypoint[]; report: MissionReport }[];
  /** True when every unit's route passed its pre-launch check. */
  flyable: boolean;
}

export function planCoverage(opts: {
  area: SurveyArea;
  swathM: number;
  units: string[];
  home: Point;
  fence: Polygon;
  noGo?: Polygon[];
  altM: number;
}): CoveragePlan {
  const { area, swathM, units } = opts;
  if (swathM <= 0) throw new Error("swath must be positive");
  if (units.length === 0) throw new Error("no units");
  const xMin = Math.min(area.x0, area.x1);
  const xMax = Math.max(area.x0, area.x1);
  const yMin = Math.min(area.y0, area.y1);
  const yMax = Math.max(area.y0, area.y1);
  const lanes = Math.max(1, Math.ceil((xMax - xMin) / swathM));
  const laneX = (i: number) => Math.min(xMin + swathM * (i + 0.5), xMax);

  // Contiguous, balanced blocks: the first (lanes % n) units take one extra lane.
  const base = Math.floor(lanes / units.length);
  const extra = lanes % units.length;
  let next = 0;
  const plan = units.map((unit, u) => {
    const count = base + (u < extra ? 1 : 0);
    const mine = Array.from({ length: count }, (_, k) => next + k);
    next += count;
    const waypoints: Waypoint[] = [];
    mine.forEach((lane, k) => {
      const x = laneX(lane);
      const [ya, yb] = k % 2 === 0 ? [yMin, yMax] : [yMax, yMin];
      waypoints.push({ x, y: ya, altM: opts.altM }, { x, y: yb, altM: opts.altM });
    });
    const report = checkMission({
      id: `coverage-${unit}`,
      platform: "POLLEN",
      home: opts.home,
      waypoints,
      fence: opts.fence,
      noGo: opts.noGo,
    });
    return { unit, lanes: mine, waypoints, report };
  });

  return { lanes, units: plan, flyable: plan.every((p) => p.waypoints.length === 0 || p.report.ok) };
}

export interface DockSlot {
  unit: string;
  pad: number;
  startMin: number;
  readyMin: number;
}

/**
 * Schedule charging on Flower's pads.
 * @param chargePerMin battery fraction added per minute on a pad.
 * @param target battery fraction at which a unit leaves the pad.
 */
export function scheduleDocking(
  units: { unit: string; battery: number }[],
  pads: number,
  chargePerMin: number,
  target = 1,
): DockSlot[] {
  if (pads < 1) throw new Error("Flower needs at least one pad");
  if (chargePerMin <= 0) throw new Error("charge rate must be positive");
  const freeAt = Array.from({ length: pads }, () => 0);
  const queue = units.filter((u) => u.battery < target).sort((a, b) => a.battery - b.battery || a.unit.localeCompare(b.unit));
  return queue.map((u) => {
    let pad = 0;
    for (let i = 1; i < pads; i++) if (freeAt[i]! < freeAt[pad]!) pad = i;
    const startMin = freeAt[pad]!;
    const readyMin = Math.round((startMin + (target - u.battery) / chargePerMin) * 10) / 10;
    freeAt[pad] = readyMin;
    return { unit: u.unit, pad, startMin, readyMin };
  });
}
