/**
 * SCALVS.ai agent: a unit of work with tools, memory and a run loop.
 * Used by Spectre's AI team and coordinated by Conductor.
 */

export interface Tool {
  name: string;
  description: string;
  execute(input: Record<string, unknown>): Promise<unknown>;
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  tools: Tool[];
  /** Optional memory key in the Nexus Context Vault. */
  memoryKey?: string;
}

export interface RunResult {
  agentId: string;
  output: unknown;
  toolCalls: { tool: string; input: Record<string, unknown>; result: unknown }[];
}

/**
 * Run an agent. If the prompt mentions a tool name, call that tool.
 * Otherwise call the first tool (if any) so agents still do useful work.
 */
export async function runAgent(agent: Agent, prompt: string): Promise<RunResult> {
  const toolCalls: RunResult["toolCalls"] = [];
  const lower = prompt.toLowerCase();

  for (const tool of agent.tools) {
    if (lower.includes(tool.name.toLowerCase()) || lower.includes(tool.name.replace(/_/g, " "))) {
      const result = await tool.execute({ prompt });
      toolCalls.push({ tool: tool.name, input: { prompt }, result });
    }
  }

  // Fallback: call the first tool so the agent still produces a result
  if (toolCalls.length === 0 && agent.tools.length > 0) {
    const tool = agent.tools[0];
    const result = await tool.execute({ prompt });
    toolCalls.push({ tool: tool.name, input: { prompt }, result });
  }

  const output = toolCalls.length
    ? toolCalls.map((c) => `${c.tool}: ${JSON.stringify(c.result)}`).join("\n")
    : `Agent ${agent.name} received: ${prompt}`;
  return { agentId: agent.id, output, toolCalls };
}
