/**
 * Hardware product catalog.
 * One profile per physical product: what it is, which commands its tasking
 * interface accepts, which telemetry fields it reports, and which commands
 * need a person's approval before they are sent. Military editions (MIL)
 * are never offered to the public Data Exchange.
 */
import { task, type HardwareTask } from "./interface.ts";

export type HardwareProductId = "DAEMON" | "SLUG" | "ORBIS" | "POLLEN" | "Flower" | "E(O)N" | ">_ARGUS";

export interface HardwareProfile {
  id: HardwareProductId;
  type: string;
  domain: "air" | "land" | "base" | "wearable" | "sensor";
  commands: readonly string[];
  /** Commands that move the platform or change its mission need approval. */
  approvalRequired: readonly string[];
  telemetry: readonly string[];
  hasMilEdition: boolean;
}

export const HARDWARE_CATALOG: Record<HardwareProductId, HardwareProfile> = {
  DAEMON: {
    id: "DAEMON",
    type: "Autonomous aircraft family",
    domain: "air",
    commands: ["preflight", "launch", "waypoint", "loiter", "survey", "return_to_base", "land", "abort"],
    approvalRequired: ["launch", "waypoint", "survey"],
    telemetry: ["lat", "lon", "altM", "airspeedMs", "headingDeg", "batteryPct", "linkQuality", "mode"],
    hasMilEdition: true,
  },
  SLUG: {
    id: "SLUG",
    type: "Autonomous land drone",
    domain: "land",
    commands: ["self_test", "drive_to", "patrol_route", "hold", "follow", "return_to_base", "stop"],
    approvalRequired: ["drive_to", "patrol_route", "follow"],
    telemetry: ["lat", "lon", "speedMs", "headingDeg", "batteryPct", "tiltDeg", "obstacleM", "mode"],
    hasMilEdition: true,
  },
  ORBIS: {
    id: "ORBIS",
    type: "Collision-tolerant spherical drone",
    domain: "air",
    commands: ["launch", "inspect", "map_interior", "hover", "return_to_base", "land", "abort"],
    approvalRequired: ["launch"],
    telemetry: ["x", "y", "z", "batteryPct", "impactCount", "mode"],
    hasMilEdition: true,
  },
  POLLEN: {
    id: "POLLEN",
    type: "Palm-sized drone swarm",
    domain: "air",
    commands: ["launch_swarm", "formation", "survey_area", "recall", "land", "abort"],
    approvalRequired: ["launch_swarm", "survey_area"],
    telemetry: ["activeUnits", "formation", "coveragePct", "minBatteryPct", "mode"],
    hasMilEdition: true,
  },
  Flower: {
    id: "Flower",
    type: "Smart base station for POLLEN",
    domain: "base",
    commands: ["status", "charge", "dock_all", "open", "close", "update_firmware"],
    approvalRequired: ["update_firmware"],
    telemetry: ["dockedUnits", "chargingUnits", "powerW", "doorState", "tempC"],
    hasMilEdition: true,
  },
  "E(O)N": {
    id: "E(O)N",
    type: "AI wearable for secure communications",
    domain: "wearable",
    commands: ["status", "pair", "unpair", "mute", "unmute", "wipe"],
    approvalRequired: ["wipe"],
    telemetry: ["batteryPct", "paired", "muted", "sessionCount"],
    hasMilEdition: true,
  },
  ">_ARGUS": {
    id: ">_ARGUS",
    type: "AI sensor fusion & ISR",
    domain: "sensor",
    commands: ["status", "add_sensor", "remove_sensor", "set_gate", "snapshot"],
    approvalRequired: ["add_sensor", "remove_sensor"],
    telemetry: ["sensorsOnline", "confirmedTracks", "tentativeTracks", "scanRateHz"],
    hasMilEdition: true,
  },
};

export interface CheckedTask extends HardwareTask {
  needsApproval: boolean;
}

/** Create a task only if the product's interface accepts the command. */
export function checkedTask(product: HardwareProductId, command: string): CheckedTask {
  const profile = HARDWARE_CATALOG[product];
  if (!profile) throw new Error(`unknown hardware product ${product}`);
  if (!profile.commands.includes(command)) {
    throw new Error(`${product} does not accept "${command}" (accepts: ${profile.commands.join(", ")})`);
  }
  return { ...task(product, command), needsApproval: profile.approvalRequired.includes(command) };
}

/** Keep only the telemetry fields the product declares. */
export function filterTelemetry(product: HardwareProductId, data: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set(HARDWARE_CATALOG[product].telemetry);
  return Object.fromEntries(Object.entries(data).filter(([k]) => allowed.has(k)));
}
