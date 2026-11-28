/**
 * Bridge Spectre ExecutionActions to Architect Scores and perform them.
 */
import { perform, registerInstrument } from "@infinitum/architect";
import type { Score } from "@infinitum/architect";
import type { ExecutionAction } from "./execution.ts";
import type { SpectreCRM } from "./crm.ts";

// Register a Spectre instrument that Architect can call
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

/** Where a performed action is recorded: always the caller's own workspace. */
export interface ExecutionTarget {
  crm: SpectreCRM;
  workspace: string;
  actor?: string;
}

const NOTE_PREFIX = "[auto] ";
const DAY = 86_400_000;

export async function executeAction(action: ExecutionAction, target?: ExecutionTarget) {
  const score = actionToScore(action);
  const granted = new Set(["spectre:write"]);
  const performance = await perform(score, granted);
  let logged = false;

  if (target && performance.verified) {
    const summary = NOTE_PREFIX + action.description;
    const now = target.crm.now().getTime();
    // Running the actions again the same day doesn't repeat a note already on the deal.
    const repeat = target.crm.list("activities", target.workspace).some((a) =>
      a.dealId === action.dealId && a.summary === summary && now - Date.parse(a.at) < DAY);
    if (!repeat) {
      await target.crm.logActivity(target.workspace, target.actor ?? "cid:spectre", { kind: "note", summary, dealId: action.dealId });
      logged = true;
    }
  }

  return { action, score, performance, logged };
}

export async function executeAll(actions: ExecutionAction[], target?: ExecutionTarget) {
  const results = [];
  for (const a of actions) results.push(await executeAction(a, target));
  return results;
}
