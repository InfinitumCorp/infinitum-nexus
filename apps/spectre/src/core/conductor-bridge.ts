/**
 * Bridge Spectre ExecutionActions to Conductor Scores and perform them.
 */
import { perform, registerInstrument } from "@infinitum/conductor";
import type { Score } from "@infinitum/conductor";
import type { ExecutionAction } from "./execution.ts";
import type { SpectreCRM } from "./crm.ts";

// Register a Spectre instrument that Conductor can call
registerInstrument({
  name: "spectre-action",
  async execute(input) {
    const action = input.action as ExecutionAction | undefined;
    if (!action) return { output: { skipped: true }, evidence: [] };
    return {
      output: { executed: action.type, dealId: action.dealId, description: action.description },
      evidence: [action.evidenceHint, `deal:${action.dealId}`],
    };
  },
});

export function actionToScore(action: ExecutionAction): Score {
  return {
    id: `score_${action.dealId}_${action.type}_${Date.now()}`,
    title: action.description,
    intent: `Self-executing: ${action.type} for ${action.dealId}`,
    autonomy: "accompaniment",
    steps: [
      {
        id: "s1",
        description: action.description,
        instrument: "spectre-action",
        input: { action },
        permissions: [{ resource: "spectre", actions: ["write"] }],
      },
    ],
    success: action.evidenceHint,
    createdAt: new Date().toISOString(),
  };
}

export async function executeAction(action: ExecutionAction, crm?: SpectreCRM, actor = "cid:spectre") {
  const score = actionToScore(action);
  const granted = new Set(["spectre:write"]);
  const performance = await perform(score, granted);

  // Optionally record a note on the deal
  if (crm && performance.verified) {
    try {
      await crm.logActivity(action.dealId.split("_")[0] ? "demo" : "demo", actor, {
        kind: "note",
        summary: `[auto] ${action.description}`,
        dealId: action.dealId,
      });
    } catch {
      // ignore if workspace/deal lookup fails in scaffold
    }
  }

  return { score, performance };
}

export async function executeAll(actions: ExecutionAction[], crm?: SpectreCRM) {
  const results = [];
  for (const a of actions) {
    results.push(await executeAction(a, crm));
  }
  return results;
}
