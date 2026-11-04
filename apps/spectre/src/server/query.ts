/**
 * Plain-language query handler for Spectre.
 * Routes to the appropriate AI agent with CRM context.
 */
import { routeQuery, runSpectreAgent, type AgentContext } from "../core/agents.ts";

export async function handleQuery(text: string, ctx: AgentContext = {}) {
  const agentId = routeQuery(text);
  const result = await runSpectreAgent(agentId, text, ctx);
  return { ...result, agentId };
}
