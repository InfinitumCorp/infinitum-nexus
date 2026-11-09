/**
 * Autonomy levels for Architect Scores.
 * - rehearsal: dry-run only (no side effects)
 * - accompaniment: execute with human confirmation points
 * - autopilot: execute fully if permissions allow
 */
import type { Autonomy, Score, Step } from "./score.ts";

export interface AutonomyDecision {
  shouldExecute: boolean;
  dryRun: boolean;
  reason: string;
}

export function decideAutonomy(score: Score, allowed: Set<Autonomy>): AutonomyDecision {
  if (!allowed.has(score.autonomy)) {
    return { shouldExecute: false, dryRun: true, reason: `Autonomy '${score.autonomy}' not allowed` };
  }
  switch (score.autonomy) {
    case "rehearsal":
      return { shouldExecute: true, dryRun: true, reason: "Rehearsal: dry-run only" };
    case "accompaniment":
      return { shouldExecute: true, dryRun: false, reason: "Accompaniment: execute with checkpoints" };
    case "autopilot":
      return { shouldExecute: true, dryRun: false, reason: "Autopilot: full execution" };
    default:
      return { shouldExecute: false, dryRun: true, reason: "Unknown autonomy" };
  }
}

export function applyDryRun(step: Step): Step {
  return {
    ...step,
    input: { ...step.input, _dryRun: true },
  };
}
