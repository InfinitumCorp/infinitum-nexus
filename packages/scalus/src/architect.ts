/**
 * SCALVS ↔ Architect integration.
 * Runs an agent and records the result as an Architect-style evidence note.
 */
import { runAgent, type Agent, type RunResult } from "./agent.ts";

export interface ArchitectEvidence {
  agentId: string;
  output: unknown;
  verified: boolean;
  at: string;
}

export async function runAndRecord(agent: Agent, prompt: string): Promise<ArchitectEvidence> {
  const result: RunResult = await runAgent(agent, prompt);
  return {
    agentId: agent.id,
    output: result.output,
    verified: result.toolCalls.every((c) => c.result !== undefined),
    at: new Date().toISOString(),
  };
}
