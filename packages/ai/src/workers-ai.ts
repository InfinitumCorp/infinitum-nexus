/**
 * Cloudflare Workers AI through the Worker's `AI` binding.
 *
 * A Worker that declares `"ai": { "binding": "AI" }` in its Wrangler config can
 * run Workers AI models with no API token, inside Cloudflare's free daily
 * allowance. This turns that binding into a router host, so a deployed product
 * gets a free open-model backup without any secret to manage.
 *
 *   const router = routerFromEnv(process.env, { providers: [...providersFromEnv(), workersAiProvider(env.AI)] });
 */
import type { Provider } from "./router.ts";

/** The part of the Workers AI binding this module uses. */
export interface WorkersAiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

/** Open-weight models on Workers AI, by canonical id. */
export const WORKERS_AI_MODELS: Record<string, string> = {
  "gpt-oss-120b": "@cf/openai/gpt-oss-120b",
  "gpt-oss-20b": "@cf/openai/gpt-oss-20b",
  "qwen3-32b": "@cf/qwen/qwen3-30b-a3b-fp8",
  "gemma-4-26b-a4b": "@cf/google/gemma-4-26b-a4b-it",
};

type RawToolCall = { id?: string; name?: string; arguments?: unknown; function?: { name?: string; arguments?: unknown } };

/** Convert whatever shape a model returns into an OpenAI chat completion. */
export function toChatCompletion(model: string, out: unknown): Record<string, unknown> {
  const o = (out ?? {}) as Record<string, unknown>;
  if (Array.isArray(o.choices)) return { model, ...o };
  const calls = (Array.isArray(o.tool_calls) ? o.tool_calls : []) as RawToolCall[];
  const tool_calls = calls.map((c, i) => {
    const name = c.function?.name ?? c.name ?? "";
    const args = c.function?.arguments ?? c.arguments ?? {};
    return { id: c.id ?? `call_${i}`, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } };
  });
  const text = typeof o.response === "string" ? o.response : o.response == null ? "" : JSON.stringify(o.response);
  return {
    model,
    choices: [{
      index: 0,
      finish_reason: tool_calls.length ? "tool_calls" : "stop",
      message: { role: "assistant", content: text, ...(tool_calls.length ? { tool_calls } : {}) },
    }],
    usage: o.usage ?? {},
  };
}

/** A fetch that answers `/chat/completions` from the binding. */
export function workersAiFetch(ai: WorkersAiBinding): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    try {
      const { model, stream: _stream, ...input } = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const out = await ai.run(String(model), input);
      return new Response(JSON.stringify(toChatCompletion(String(model), out)), { status: 200, headers: { "content-type": "application/json" } });
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      // Daily allowance used up or rate limited: let the router cool this host down.
      const status = /neuron|quota|limit|429/i.test(message) ? 429 : 502;
      return new Response(JSON.stringify({ error: { message } }), { status, headers: { "content-type": "application/json" } });
    }
  }) as typeof fetch;
}

/** A router host backed by the Worker's AI binding. Needs no key. */
export function workersAiProvider(ai: WorkersAiBinding, models: Record<string, string> = WORKERS_AI_MODELS): Provider {
  return { name: "workers-ai-binding", baseUrl: "https://workers-ai.binding", models: { ...models }, fetch: workersAiFetch(ai) };
}
