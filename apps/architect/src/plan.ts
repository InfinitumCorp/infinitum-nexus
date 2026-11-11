/**
 * Intent → Score. The Conductor server and the Architect server share this planner.
 */
import type { Autonomy, Score } from "./score.ts";

export function planScore(intent: string, autonomy: Autonomy = "rehearsal"): Score {
  return {
    id: `score_${Date.now()}`,
    title: intent.slice(0, 60),
    intent,
    autonomy,
    steps: [
      {
        id: "s1",
        description: `Research: ${intent}`,
        instrument: "research",
        input: { query: intent },
        permissions: [{ resource: "web", actions: ["read"] }],
      },
    ],
    success: "research completed",
    createdAt: new Date().toISOString(),
  };
}
