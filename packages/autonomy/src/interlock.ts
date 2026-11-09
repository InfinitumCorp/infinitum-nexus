/**
 * Runtime safety interlock.
 * Runs on every telemetry tick and decides what the platform must do,
 * independent of the mission plan. The most severe rule wins. Operators can
 * always command a stop; the interlock can only make the platform safer.
 */
import { ENVELOPES, type MobilePlatform } from "./platforms.ts";
import { energyToReturnWh } from "./mission.ts";
import { inside, type Point, type Polygon } from "./geo.ts";

export type InterlockAction = "continue" | "hold" | "return_to_base" | "land_now";

export interface Tick {
  position: Point;
  altM?: number;
  /** Battery 0–1. */
  battery: number;
  /** Seconds since the last packet from the operator link. */
  linkSilentS: number;
}

export interface InterlockConfig {
  fence: Polygon;
  home: Point;
  /** Seconds of link loss before holding position. */
  holdAfterS: number;
  /** Seconds of link loss before returning home. */
  returnAfterS: number;
}

export interface InterlockDecision {
  action: InterlockAction;
  reasons: string[];
}

const SEVERITY: Record<InterlockAction, number> = { continue: 0, hold: 1, return_to_base: 2, land_now: 3 };

export function evaluate(platform: MobilePlatform, tick: Tick, cfg: InterlockConfig): InterlockDecision {
  const env = ENVELOPES[platform];
  const found: { action: InterlockAction; reason: string }[] = [];

  const whLeft = tick.battery * env.batteryWh;
  const whHome = energyToReturnWh(platform, tick.position, cfg.home);
  const whHomeNoReserve = whHome - env.reserve * env.batteryWh;
  if (whLeft < whHomeNoReserve) {
    found.push({ action: env.domain === "air" ? "land_now" : "hold", reason: "Not enough battery to reach home; stopping where it is." });
  } else if (whLeft <= whHome) {
    found.push({ action: "return_to_base", reason: "Battery is at the level needed to get home with the reserve." });
  }

  if (!inside(tick.position, cfg.fence)) {
    found.push({ action: "return_to_base", reason: "Outside the operating fence." });
  }
  if (env.domain === "air" && (tick.altM ?? 0) > env.maxAltM) {
    found.push({ action: "return_to_base", reason: `Above the ${env.maxAltM} m ceiling.` });
  }

  if (tick.linkSilentS >= cfg.returnAfterS) {
    found.push({ action: "return_to_base", reason: `Operator link silent for ${tick.linkSilentS} s.` });
  } else if (tick.linkSilentS >= cfg.holdAfterS) {
    found.push({ action: "hold", reason: `Operator link silent for ${tick.linkSilentS} s; holding.` });
  }

  if (found.length === 0) return { action: "continue", reasons: [] };
  const worst = found.reduce((a, b) => (SEVERITY[b.action] > SEVERITY[a.action] ? b : a));
  return { action: worst.action, reasons: found.map((f) => f.reason) };
}
