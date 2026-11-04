/**
 * Self-executing deals.
 * Rules evaluate a deal + score and, when matched, produce an executable action
 * that Conductor (or a local executor) can perform.
 */
import type { Deal, Activity } from "./model.ts";
import type { Score } from "./intelligence.ts";
import type { NextAction } from "./intelligence.ts";

export interface ExecutionRule {
  id: string;
  name: string;
  /** Autonomy level required to auto-run. */
  autonomy: "rehearsal" | "accompaniment" | "autopilot";
  match(deal: Deal, score: Score, next: NextAction): boolean;
  action(deal: Deal, score: Score, next: NextAction): ExecutionAction;
}

export interface ExecutionAction {
  dealId: string;
  type: "create_task" | "send_email" | "log_note" | "advance_stage" | "notify";
  description: string;
  payload: Record<string, unknown>;
  /** Evidence that will be written to Firmament after execution. */
  evidenceHint: string;
}

export const DEFAULT_RULES: ExecutionRule[] = [
  {
    id: "high-prob-proposal",
    name: "High-probability proposal follow-up",
    autonomy: "accompaniment",
    match: (d, s) => d.stage === "proposal" && s.probability >= 0.55 && s.risk === "low",
    action: (d, _s, next) => ({
      dealId: d.id,
      type: "create_task",
      description: next.action,
      payload: { dueInDays: 1, channel: next.channel },
      evidenceHint: "auto-task-created",
    }),
  },
  {
    id: "stale-reengage",
    name: "Stale deal re-engagement",
    autonomy: "rehearsal",
    match: (_d, s) => s.factors.some((f) => f.label.includes("No contact in") || f.label.includes("Stuck in")),
    action: (d, s, next) => ({
      dealId: d.id,
      type: "notify",
      description: `Re-engage: ${next.action}`,
      payload: { reason: s.factors.find((f) => f.effect < 1)?.label ?? "stale" },
      evidenceHint: "reengage-suggested",
    }),
  },
  {
    id: "close-date-passed",
    name: "Close date passed",
    autonomy: "rehearsal",
    match: (_d, s) => s.factors.some((f) => f.label.startsWith("Close date passed")),
    action: (d, s) => ({
      dealId: d.id,
      type: "notify",
      description: "Confirm a new close date",
      payload: { factor: s.factors.find((f) => f.label.startsWith("Close date passed"))?.label },
      evidenceHint: "close-date-alert",
    }),
  },
];

export function evaluateExecution(
  deal: Deal,
  score: Score,
  next: NextAction,
  rules: ExecutionRule[] = DEFAULT_RULES,
  allowedAutonomy: Set<string> = new Set(["rehearsal", "accompaniment", "autopilot"]),
): ExecutionAction[] {
  return rules
    .filter((r) => allowedAutonomy.has(r.autonomy) && r.match(deal, score, next))
    .map((r) => r.action(deal, score, next));
}
