/**
 * Plain-language query handler for Spectre.
 * Routes to the appropriate AI agent.
 */
import { routeQuery, runSpectreAgent } from "../core/agents.ts";

export async function handleQuery(text: string) {
  const agentId = routeQuery(text);
  const result = await runSpectreAgent(agentId, text);
  return { agentId, ...result };
}
