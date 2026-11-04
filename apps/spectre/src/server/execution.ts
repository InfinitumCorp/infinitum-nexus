/**
 * Endpoint helper for self-executing deals.
 */
import type { SpectreCRM } from "../core/crm.ts";
import { scoreDeal, nextBestAction } from "../core/intelligence.ts";
import { evaluateExecution } from "../core/execution.ts";

export async function listPendingActions(crm: SpectreCRM, workspace: string) {
  const deals = crm.list("deals", workspace);
  const activities = crm.list("activities", workspace);
  const now = crm.now();
  const pending: ReturnType<typeof evaluateExecution> = [];

  for (const d of deals) {
    if (d.stage === "won" || d.stage === "lost") continue;
    const score = scoreDeal(d, activities, now);
    const next = nextBestAction(d, score, activities, now);
    pending.push(...evaluateExecution(d, score, next));
  }
  return pending;
}
