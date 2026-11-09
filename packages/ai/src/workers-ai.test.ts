import { test } from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "./router.ts";
import { toChatCompletion, workersAiProvider } from "./workers-ai.ts";

test("workers-ai: wraps plain and tool-call replies as chat completions", () => {
  const plain = toChatCompletion("m", { response: "hi" }) as any;
  assert.equal(plain.choices[0].message.content, "hi");
  const tools = toChatCompletion("m", { response: null, tool_calls: [{ name: "weather", arguments: { city: "Paris" } }] }) as any;
  assert.equal(tools.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(JSON.parse(tools.choices[0].message.tool_calls[0].function.arguments), { city: "Paris" });
  const passthrough = toChatCompletion("m", { choices: [{ message: { content: "x" } }] }) as any;
  assert.equal(passthrough.choices[0].message.content, "x");
});

test("workers-ai: the binding serves the router with no key, and a spent allowance fails over", async () => {
  const seen: string[] = [];
  const ai = { run: async (model: string, input: Record<string, unknown>) => {
    seen.push(model);
    assert.ok(Array.isArray(input.messages));
    if (model.endsWith("120b")) throw new Error("you have used up your daily free allocation of 10,000 neurons");
    return { response: "<think>x</think>ok" };
  } };
  const router = createRouter({ providers: [workersAiProvider(ai)], hedgeMs: 0, fetchImpl: (() => { throw new Error("network fetch must not be used"); }) as unknown as typeof fetch });
  const r = await router.chat({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(r.text, "ok");
  assert.equal(r.provider, "workers-ai-binding");
  assert.equal(seen[0], "@cf/openai/gpt-oss-120b");
});
