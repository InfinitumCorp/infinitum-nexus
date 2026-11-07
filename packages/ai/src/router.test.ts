import { test } from "node:test";
import assert from "node:assert/strict";
import { createRouter, AiNotConfigured, type Provider } from "./router.ts";
import { providersFromEnv } from "./env.ts";

type Handler = (url: string, body: any) => Response | Promise<Response>;

function fakeFetch(handler: Handler) {
  const calls: { url: string; body: any; auth?: string }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, body, auth: (init.headers as Record<string, string>).authorization });
    if (init.signal?.aborted) throw new Error("aborted");
    return handler(url, body);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const reply = (content: string | null, extra: Record<string, unknown> = {}) =>
  Response.json({ choices: [{ message: { content, ...extra }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } });

const A: Provider = { name: "a", baseUrl: "https://a.test/v1", apiKey: "ka", models: { "gpt-oss-120b": "a-120b", "deepseek-v3": "a-deepseek" } };
const B: Provider = { name: "b", baseUrl: "https://b.test/v1/", apiKey: "kb", models: { "gpt-oss-120b": "b-120b" } };

test("no providers: not configured", async () => {
  const r = createRouter({ providers: [] });
  assert.equal(r.connected, false);
  await assert.rejects(r.complete("s", "u"), AiNotConfigured);
});

test("sends OpenAI-compatible requests and strips <think>", async () => {
  const f = fakeFetch(() => reply("<think>hmm</think> Hello"));
  const r = createRouter({ providers: [A], fetchImpl: f.impl, hedgeMs: 0 });
  const res = await r.chat({ system: "sys", messages: [{ role: "user", content: "hi" }], maxTokens: 50 });
  assert.equal(res.text, "Hello");
  assert.equal(res.provider, "a");
  assert.equal(res.model, "gpt-oss-120b");
  assert.equal(f.calls[0]!.url, "https://a.test/v1/chat/completions");
  assert.equal(f.calls[0]!.auth, "Bearer ka");
  assert.deepEqual(f.calls[0]!.body.messages, [{ role: "system", content: "sys" }, { role: "user", content: "hi" }]);
  assert.equal(f.calls[0]!.body.model, "a-120b");
});

test("fails over instantly on errors, then skips the cooling candidate next time", async () => {
  let t = 0;
  const f = fakeFetch((url, body) => (body.model === "a-120b" ? new Response("down", { status: 503 }) : reply(`from ${body.model}`)));
  const r = createRouter({ providers: [A, B], fetchImpl: f.impl, hedgeMs: 0, now: () => t });
  const first = await r.chat({ messages: [{ role: "user", content: "x" }] });
  assert.equal(first.text, "from b-120b");
  assert.equal(first.attempts.length, 2);
  assert.equal(first.attempts[0]!.status, 503);
  f.calls.length = 0;
  const second = await r.chat({ messages: [{ role: "user", content: "x" }] });
  assert.equal(second.text, "from b-120b");
  assert.equal(f.calls.length, 1, "cooling candidate is skipped");
  t = 10 * 60_000;
  assert.equal(r.candidates()[0]!.hostModel, "a-120b", "recovers after cool-down");
});

test("bad key parks the whole host", async () => {
  const f = fakeFetch((url, body) => (url.startsWith("https://a.test") ? new Response("no", { status: 401 }) : reply("ok")));
  const r = createRouter({ providers: [A, B], fetchImpl: f.impl, hedgeMs: 0 });
  await r.chat({ messages: [{ role: "user", content: "x" }] });
  assert.ok(r.candidates().slice(0, 1).every((c) => c.provider.name === "b"));
  assert.ok(r.status().filter((s) => s.provider === "a").every((s) => !s.healthy));
});

test("malformed tool arguments switch models", async () => {
  const f = fakeFetch((url, body) =>
    body.model === "a-120b"
      ? reply(null, { tool_calls: [{ id: "1", function: { name: "lookup", arguments: "{bad" } }] })
      : reply(null, { tool_calls: [{ id: "2", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }] }),
  );
  const r = createRouter({ providers: [A, B], fetchImpl: f.impl, hedgeMs: 0 });
  const res = await r.chat({ messages: [{ role: "user", content: "x" }], tools: [{ name: "lookup", description: "d", parameters: { type: "object", properties: {} } }] });
  assert.equal(res.finishReason, "tool_calls");
  assert.deepEqual(res.toolCalls, [{ id: "2", name: "lookup", arguments: { q: "x" } }]);
  assert.equal(f.calls[0]!.body.tools[0].type, "function");
});

test("hedging: a slow candidate is raced and the faster answer wins", async () => {
  const f = fakeFetch(async (url, body) => {
    if (body.model === "a-120b") await new Promise((r) => setTimeout(r, 300));
    return reply(`from ${body.model}`);
  });
  const r = createRouter({ providers: [A, B], fetchImpl: f.impl, hedgeMs: 20 });
  const started = Date.now();
  const res = await r.chat({ messages: [{ role: "user", content: "x" }] });
  assert.equal(res.text, "from b-120b");
  assert.ok(Date.now() - started < 250);
});

test("all candidates failing gives one clear error", async () => {
  const f = fakeFetch(() => new Response("x", { status: 500 }));
  const r = createRouter({ providers: [A, B], fetchImpl: f.impl, hedgeMs: 0 });
  await assert.rejects(r.complete("s", "u"), /Every model failed \(3 attempts\)/);
});

test("tool results round-trip in OpenAI format so another model can continue", async () => {
  const f = fakeFetch(() => reply("done"));
  const r = createRouter({ providers: [A], fetchImpl: f.impl, hedgeMs: 0 });
  await r.chat({
    messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "lookup", arguments: { q: 1 } }] },
      { role: "tool", toolCallId: "c1", content: "result" },
    ],
  });
  const msgs = f.calls[0]!.body.messages;
  assert.deepEqual(msgs[1], { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "lookup", arguments: "{\"q\":1}" } }] });
  assert.deepEqual(msgs[2], { role: "tool", tool_call_id: "c1", content: "result" });
});

test("env: OmniRoute first, gateway tier models, then direct hosts", async () => {
  const providers = providersFromEnv({
    OMNIROUTE_API_KEY: "k1", OMNIROUTE_SMART_MODEL: "smart-combo", OMNIROUTE_FAST_MODEL: "fast-combo",
    GROQ_API_KEY: "k2", OLLAMA_BASE_URL: "http://localhost:11434/v1",
    AI_MODEL_MAP: JSON.stringify({ groq: { "gpt-oss-120b": "renamed" } }),
  });
  assert.deepEqual(providers.map((p) => p.name), ["omniroute", "groq", "ollama"]);
  assert.equal(providers[0]!.baseUrl, "http://localhost:20128/v1");
  assert.equal(providers[1]!.models["gpt-oss-120b"], "renamed");
  const r = createRouter({ providers });
  assert.equal(r.candidates({ tier: "smart" })[0]!.hostModel, "smart-combo");
  assert.equal(r.candidates({ tier: "fast" })[0]!.hostModel, "fast-combo");
  assert.equal(r.candidates({ tier: "smart" })[1]!.hostModel, "renamed");
});

test("env: OmniRoute defaults to its auto model; order override works", () => {
  const o = providersFromEnv({ OMNIROUTE_API_KEY: "k" });
  assert.deepEqual(o.map((p) => p.name), ["omniroute"]);
  assert.deepEqual(o[0]!.tierModels, { smart: "auto", fast: "auto" });
  const p = providersFromEnv({ GROQ_API_KEY: "a", TOGETHER_API_KEY: "b", AI_PROVIDER_ORDER: "together,groq" });
  assert.deepEqual(p.map((x) => x.name), ["together", "groq"]);
});
