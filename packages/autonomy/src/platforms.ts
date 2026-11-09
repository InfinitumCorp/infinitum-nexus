/**
 * Performance envelopes used for planning. These are planning defaults for
 * the simulator and mission checks, not measured specifications; replace
 * them with flight-test or field data per airframe/chassis.
 */
import type { HardwareProductId } from "@infinitum/hardware";

export type MobilePlatform = Extract<HardwareProductId, "DAEMON" | "SLUG" | "ORBIS" | "POLLEN">;

export interface PlatformEnvelope {
  id: MobilePlatform;
  domain: "air" | "land";
  cruiseMs: number;
  /** Energy per metre travelled at cruise (Wh/m). */
  whPerMetre: number;
  /** Energy per second while hovering/holding (Wh/s). 0 for ground vehicles at rest. */
  whPerSecondHold: number;
  batteryWh: number;
  /** Highest altitude above ground the planner will accept (air only). */
  maxAltM: number;
  /** Fraction of the battery that must remain on landing. */
  reserve: number;
}

export const ENVELOPES: Record<MobilePlatform, PlatformEnvelope> = {
  DAEMON: { id: "DAEMON", domain: "air", cruiseMs: 18, whPerMetre: 0.012, whPerSecondHold: 0.12, batteryWh: 900, maxAltM: 120, reserve: 0.2 },
  SLUG: { id: "SLUG", domain: "land", cruiseMs: 2.5, whPerMetre: 0.04, whPerSecondHold: 0, batteryWh: 1500, maxAltM: 0, reserve: 0.15 },
  ORBIS: { id: "ORBIS", domain: "air", cruiseMs: 4, whPerMetre: 0.006, whPerSecondHold: 0.03, batteryWh: 90, maxAltM: 30, reserve: 0.25 },
  POLLEN: { id: "POLLEN", domain: "air", cruiseMs: 6, whPerMetre: 0.0015, whPerSecondHold: 0.006, batteryWh: 12, maxAltM: 60, reserve: 0.25 },
};
