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

/** Minimal run: the agent receives a prompt and may call registered tools. */
export async function runAgent(agent: Agent, prompt: string): Promise<RunResult> {
  const toolCalls: RunResult["toolCalls"] = [];
  // Scaffold: if the prompt mentions a tool name, call it with the rest of the prompt as input.
  for (const tool of agent.tools) {
    if (prompt.toLowerCase().includes(tool.name.toLowerCase())) {
      const result = await tool.execute({ prompt });
      toolCalls.push({ tool: tool.name, input: { prompt }, result });
    }
  }
  const output = toolCalls.length
    ? toolCalls.map((c) => `${c.tool}: ${JSON.stringify(c.result)}`).join("\n")
    : `Agent ${agent.name} received: ${prompt}`;
  return { agentId: agent.id, output, toolCalls };
}
