/**
 * SCALVS ↔ Architect integration.
 * Runs an agent and records the result as a Architect-style evidence note.
 */
import { runAgent, type Agent, type RunResult } from "./agent.ts";

export interface ConductorEvidence {
  agentId: string;
  output: unknown;
  verified: boolean;
  at: string;
}

export async function runAndRecord(agent: Agent, prompt: string): Promise<ConductorEvidence> {
  const result: RunResult = await runAgent(agent, prompt);
  return {
    agentId: agent.id,
    output: result.output,
    verified: result.toolCalls.every((c) => c.result !== undefined),
    at: new Date().toISOString(),
  };
}
