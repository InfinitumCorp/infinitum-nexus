/**
 * SCALVS.ai agent engine: the model plans, calls tools, reads the results and continues
 * until it can answer. Runs on open-weight models through @infinitum/ai, which
 * switches model or host automatically mid-run if one fails or stalls.
 *
 * Human approval: tools marked `effect: "propose"` never run during the agent's turn.
 * The call becomes a Proposal the host product shows to a person, who approves or
 * dismisses it. "Agents draft and recommend; your team approves anything that reaches
 * a customer."
 */
import { AiError, sharedRouter, type AiRouter, type ChatMessage, type Tier } from "@infinitum/ai";

export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

export interface LlmTool {
  name: string;
  description: string;
  input_schema: JsonSchema;
  /** "read" runs immediately. "propose" is queued for human approval and never runs here. */
  effect: "read" | "propose";
  /** For read tools: the result returned to the model. */
  run?(input: Record<string, unknown>): Promise<unknown> | unknown;
  /** For propose tools: a one-line, human-readable description of what approving will do. */
  describe?(input: Record<string, unknown>): string;
}

export interface Proposal {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  summary: string;
}

export interface Step {
  tool: string;
  input: Record<string, unknown>;
  result: unknown;
  /** True when the step was a proposal awaiting approval. */
  proposed?: boolean;
  error?: string;
}

export interface LlmAgentResult {
  output: string;
  steps: Step[];
  proposals: Proposal[];
  usage: { inputTokens: number; outputTokens: number; calls: number };
  stopReason: "done" | "step_limit";
}

export interface LlmConfig {
  /** The open-model router. Defaults to the process-wide router built from the environment. */
  router?: AiRouter;
  /** "smart" (default) for planning agents, "fast" for light work. */
  tier?: Tier;
  /** Max model calls per run (each may request several tools). Default 8. */
  maxSteps?: number;
  maxTokens?: number;
  /** Id generator for proposals (injected in tests). */
  newId?: () => string;
}

export class LlmError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/** Cap what one tool result can add to the conversation. */
function serialize(result: unknown, limit = 12_000): string {
  const text = typeof result === "string" ? result : JSON.stringify(result);
  return text.length > limit ? `${text.slice(0, limit)}… [truncated ${text.length - limit} characters]` : text;
}

export async function runLlmAgent(
  cfg: LlmConfig,
  agent: { system: string; tools: LlmTool[] },
  prompt: string,
): Promise<LlmAgentResult> {
  const router = cfg.router ?? sharedRouter();
  const maxSteps = cfg.maxSteps ?? 8;
  const newId = cfg.newId ?? (() => `prop_${crypto.randomUUID()}`);
  const byName = new Map(agent.tools.map((t) => [t.name, t]));
  const tools = agent.tools.map(({ name, description, input_schema }) => ({ name, description, parameters: input_schema as unknown as Record<string, unknown> }));
  const messages: ChatMessage[] = [{ role: "user", content: prompt }];
  const steps: Step[] = [];
  const proposals: Proposal[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, calls: 0 };

  for (let i = 0; i < maxSteps; i++) {
    let reply;
    try {
      reply = await router.chat({ system: agent.system, messages, tools: tools.length ? tools : undefined, maxTokens: cfg.maxTokens ?? 2000, tier: cfg.tier });
    } catch (err) {
      const status = err instanceof AiError ? (err.attempts.filter((a) => a.status).at(-1)?.status ?? err.status) : undefined;
      throw new LlmError((err as Error).message, status);
    }
    usage.calls++;
    usage.inputTokens += reply.usage.inputTokens;
    usage.outputTokens += reply.usage.outputTokens;
    messages.push({ role: "assistant", content: reply.text, toolCalls: reply.toolCalls.length ? reply.toolCalls : undefined });

    if (reply.toolCalls.length === 0) return { output: reply.text, steps, proposals, usage, stopReason: "done" };

    for (const call of reply.toolCalls) {
      const tool = byName.get(call.name);
      const input = call.arguments ?? {};
      const answer = (content: string) => messages.push({ role: "tool", toolCallId: call.id, content });
      if (!tool) {
        steps.push({ tool: call.name, input, result: null, error: "unknown tool" });
        answer(`Error: no tool named ${call.name}.`);
        continue;
      }
      if (tool.effect === "propose") {
        const proposal: Proposal = { id: newId(), tool: tool.name, input, summary: tool.describe?.(input) ?? `${tool.name}` };
        proposals.push(proposal);
        steps.push({ tool: tool.name, input, result: { queuedForApproval: proposal.id }, proposed: true });
        answer(`Queued for human approval as ${proposal.id}. It has NOT happened yet; say so in your answer.`);
        continue;
      }
      try {
        const result = await tool.run!(input);
        steps.push({ tool: tool.name, input, result });
        answer(serialize(result));
      } catch (err) {
        const message = (err as Error).message;
        steps.push({ tool: tool.name, input, result: null, error: message });
        answer(`Error: ${message}`);
      }
    }
  }

  return {
    output: "I reached my step limit before finishing. Here's what I found so far; ask me to continue with a narrower request.",
    steps,
    proposals,
    usage,
    stopReason: "step_limit",
  };
}
