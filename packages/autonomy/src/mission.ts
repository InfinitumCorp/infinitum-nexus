/**
 * Pre-launch mission check.
 * A mission is accepted only when every leg stays inside the operating
 * fence, no leg enters a no-go zone, altitudes suit the platform, and the
 * battery covers the route, the hold time and the leg home with the
 * platform's reserve left over. Every mission also needs a person's
 * approval before launch; the check never grants it.
 */
import { ENVELOPES, type MobilePlatform } from "./platforms.ts";
import { distance, legEntersPolygon, legInsidePolygon, pathLength, type Point, type Polygon } from "./geo.ts";

export interface Waypoint extends Point {
  /** Metres above ground. Ignored for land platforms. */
  altM?: number;
  /** Seconds to hold at this waypoint. */
  holdS?: number;
}

export interface Mission {
  id: string;
  platform: MobilePlatform;
  home: Point;
  waypoints: Waypoint[];
  fence: Polygon;
  noGo?: Polygon[];
  /** Battery at launch, 0–1. Defaults to full. */
  batteryAtLaunch?: number;
}

export type IssueCode =
  | "empty_route"
  | "home_outside_fence"
  | "leaves_fence"
  | "enters_no_go"
  | "altitude_too_high"
  | "altitude_on_ground_platform"
  | "insufficient_energy";

export interface MissionIssue {
  code: IssueCode;
  leg?: number;
  detail: string;
}

export interface MissionReport {
  missionId: string;
  ok: boolean;
  issues: MissionIssue[];
  distanceM: number;
  durationS: number;
  energyWh: number;
  /** Battery fraction expected on landing. */
  landingBattery: number;
  /** Always true: launch waits for a person's approval. */
  needsApproval: true;
}

export function checkMission(m: Mission): MissionReport {
  const env = ENVELOPES[m.platform];
  const issues: MissionIssue[] = [];
  const route: Point[] = [m.home, ...m.waypoints, m.home];

  if (m.waypoints.length === 0) issues.push({ code: "empty_route", detail: "The mission has no waypoints." });
  if (!legInsidePolygon(m.home, m.home, m.fence)) {
    issues.push({ code: "home_outside_fence", detail: "Home is outside the operating fence." });
  }

  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1]!;
    const b = route[i]!;
    const leg = i;
    if (!legInsidePolygon(a, b, m.fence)) issues.push({ code: "leaves_fence", leg, detail: `Leg ${leg} leaves the operating fence.` });
    for (const [z, zone] of (m.noGo ?? []).entries()) {
      if (legEntersPolygon(a, b, zone)) issues.push({ code: "enters_no_go", leg, detail: `Leg ${leg} enters no-go zone ${z + 1}.` });
    }
  }

  m.waypoints.forEach((w, i) => {
    if (env.domain === "land" && (w.altM ?? 0) > 0) {
      issues.push({ code: "altitude_on_ground_platform", leg: i + 1, detail: `${m.platform} is a ground vehicle; waypoint ${i + 1} has an altitude.` });
    }
    if (env.domain === "air" && (w.altM ?? 0) > env.maxAltM) {
      issues.push({ code: "altitude_too_high", leg: i + 1, detail: `Waypoint ${i + 1} is at ${w.altM} m; ${m.platform} is limited to ${env.maxAltM} m.` });
    }
  });

  const distanceM = pathLength(route);
  const holdS = m.waypoints.reduce((s, w) => s + (w.holdS ?? 0), 0);
  const durationS = distanceM / env.cruiseMs + holdS;
  const energyWh = distanceM * env.whPerMetre + holdS * env.whPerSecondHold;
  const available = env.batteryWh * (m.batteryAtLaunch ?? 1);
  const landingBattery = (available - energyWh) / env.batteryWh;
  if (landingBattery < env.reserve) {
    issues.push({
      code: "insufficient_energy",
      detail: `Expected landing battery ${(landingBattery * 100).toFixed(0)}%, below the ${(env.reserve * 100).toFixed(0)}% reserve.`,
    });
  }

  return {
    missionId: m.id,
    ok: issues.length === 0,
    issues,
    distanceM: Math.round(distanceM),
    durationS: Math.round(durationS),
    energyWh: Math.round(energyWh * 10) / 10,
    landingBattery: Math.round(landingBattery * 1000) / 1000,
    needsApproval: true,
  };
}

/** Energy needed to fly/drive straight home from a point, plus the reserve. */
export function energyToReturnWh(platform: MobilePlatform, from: Point, home: Point): number {
  const env = ENVELOPES[platform];
  return distance(from, home) * env.whPerMetre + env.reserve * env.batteryWh;
}
