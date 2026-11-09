/**
 * Test helpers: a router backed by a scripted OpenAI-compatible host, so app
 * tests can script model replies without any network.
 */
import { createRouter, type AiRouter } from "./router.ts";

export type Reply = unknown | Response;

export function textReply(text: string, usage = { prompt_tokens: 10, completion_tokens: 5 }) {
  return { choices: [{ message: { content: text }, finish_reason: "stop" }], usage };
}

export function toolReply(calls: { name: string; input: Record<string, unknown>; id?: string }[], usage = { prompt_tokens: 10, completion_tokens: 5 }) {
  return {
    choices: [{
      message: { content: null, tool_calls: calls.map((c, i) => ({ id: c.id ?? `call_${i}_${Math.random().toString(36).slice(2, 8)}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input) } })) },
      finish_reason: "tool_calls",
    }],
    usage,
  };
}

/** A router with one fake host. `next` returns the reply for each request (JSON body or a Response). */
export function scriptedRouter(next: (body: any) => Reply, model = "test-model"): { router: AiRouter; requests: any[] } {
  const requests: any[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push(body);
    const r = next(body);
    return r instanceof Response ? r : new Response(JSON.stringify(r), { status: 200 });
  }) as unknown as typeof fetch;
  const router = createRouter({ providers: [{ name: "test", baseUrl: "http://ai.test/v1", models: { "gpt-oss-120b": model } }], fetchImpl, hedgeMs: 0, cooldownMs: 0 });
  return { router, requests };
}

/** Replies in order, then `fallback` once the queue is empty. */
export function queuedRouter(queue: Reply[], fallback: Reply = textReply("done"), model?: string) {
  return { ...scriptedRouter(() => (queue.length ? queue.shift() : fallback), model), queue };
}
