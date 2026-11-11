import { test } from "node:test";
import assert from "node:assert/strict";
import type { WorkersAiBinding } from "@infinitum/ai";
import { AiNotConnected, askSpectre, spectreAiRouter } from "./ai.ts";

const completion = (text: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: "stop" }], usage: {} }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

test("Workers AI answers when no OMNIROUTE host is configured", async () => {
  let network = false;
  const ai: WorkersAiBinding = {
    async run(model) {
      assert.equal(model, "@cf/openai/gpt-oss-120b");
      return { response: "Northwind is in proposal." };
    },
  };
  const fetchImpl = (() => {
    network = true;
    throw new Error("network fetch must not be used");
  }) as typeof fetch;
  const router = spectreAiRouter({}, ai, { fetchImpl, hedgeMs: 0 });
  assert.equal(router.connected, true);
  assert.equal(router.providers[0], "workers-ai-binding");
  const answer = await askSpectre({ router }, "Where is Northwind?", { companies: ["Northwind"] });
  assert.match(answer, /Northwind/);
  assert.equal(network, false);
});

test("a spent Workers AI allowance falls back to OMNIROUTE", async () => {
  const ai: WorkersAiBinding = {
    async run() {
      throw new Error("you have used up your daily free allocation of 10,000 neurons");
    },
  };
  const fetchImpl = (async (url: string | URL | Request) => {
    assert.match(String(url), /^http:\/\/omni\.test\/v1\/chat\/completions$/);
    return completion("from omniroute");
  }) as typeof fetch;
  const router = spectreAiRouter(
    { OMNIROUTE_BASE_URL: "http://omni.test/v1", OMNIROUTE_SMART_MODEL: "auto" },
    ai,
    { fetchImpl, hedgeMs: 0 },
  );
  assert.deepEqual(router.providers, ["workers-ai-binding", "omniroute"]);
  const result = await router.chat({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(result.text, "from omniroute");
  assert.equal(result.provider, "omniroute");
  assert.equal(result.attempts[0].provider, "workers-ai-binding");
  assert.equal(result.attempts[0].ok, false);
});

test("OMNIROUTE is used when the Workers AI binding is absent", async () => {
  const fetchImpl = (async () => completion("local combo")) as typeof fetch;
  const router = spectreAiRouter({ OMNIROUTE_BASE_URL: "http://127.0.0.1:20128/v1" }, undefined, { fetchImpl, hedgeMs: 0 });
  assert.deepEqual(router.providers, ["omniroute"]);
  assert.equal(await router.complete("system", "ping"), "local combo");
});

test("with neither Workers AI nor OMNIROUTE, Ask Spectre keeps the not-connected message", async () => {
  const router = spectreAiRouter({}, undefined, { hedgeMs: 0 });
  assert.equal(router.connected, false);
  await assert.rejects(askSpectre({ router }, "hello", {}), (err: unknown) => {
    assert.ok(err instanceof AiNotConnected);
    assert.match(err.message, /isn't connected yet/);
    assert.match(err.message, /OMNIROUTE_API_KEY/);
    return true;
  });
});
