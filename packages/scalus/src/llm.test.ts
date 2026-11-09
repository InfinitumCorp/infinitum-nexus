import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runLlmAgent, LlmError, type LlmTool } from "./llm.ts";

/** A scripted stand-in for the Claude API: returns the queued responses in order and records requests. */
function fakeClaude(replies: unknown[]) {
  const requests: any[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    const next = replies.shift();
    if (next instanceof Response) return next;
    return new Response(JSON.stringify(next), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  stop_reason: "tool_use",
  content: [{ type: "tool_use", id, name, input }],
  usage: { input_tokens: 100, output_tokens: 20 },
});
const final = (text: string) => ({ stop_reason: "end_turn", content: [{ type: "text", text }], usage: { input_tokens: 150, output_tokens: 40 } });

const listDeals: LlmTool = {
  name: "list_open_deals",
  description: "List open deals",
  input_schema: { type: "object", properties: {} },
  effect: "read",
  run: () => [{ id: "dl_1", name: "Fleet rollout", probability: 0.62 }],
};
const createTask: LlmTool = {
  name: "create_task",
  description: "Create a follow-up task",
  input_schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
  effect: "propose",
  run: () => { throw new Error("propose tools must never run inside the agent loop"); },
  describe: (i) => `Create task: ${i.summary}`,
};

describe("SCALVS.ai agent engine", () => {
  it("calls read tools, feeds results back, and returns the final answer", async () => {
    const claude = fakeClaude([toolUse("t1", "list_open_deals", {}), final("Fleet rollout is your best deal at 62%.")]);
    const r = await runLlmAgent({ apiKey: "k", model: "m", fetchImpl: claude.fetchImpl }, { system: "sys", tools: [listDeals] }, "Which deal is best?");
    assert.equal(r.output, "Fleet rollout is your best deal at 62%.");
    assert.equal(r.steps[0].tool, "list_open_deals");
    assert.equal(r.usage.calls, 2);
    assert.equal(r.usage.inputTokens, 250);
    // The tool result went back to the model in the second request.
    const second = claude.requests[1].messages;
    assert.equal(second[2].content[0].type, "tool_result");
    assert.match(second[2].content[0].content, /Fleet rollout/);
    assert.deepEqual(claude.requests[0].tools.map((t: any) => t.name), ["list_open_deals"]);
    assert.ok(!("effect" in claude.requests[0].tools[0]), "internal fields aren't sent to the API");
  });

  it("queues write actions for human approval instead of running them", async () => {
    const claude = fakeClaude([toolUse("t1", "create_task", { summary: "Call Dana" }), final("I've proposed a task to call Dana; it needs your approval.")]);
    let n = 0;
    const r = await runLlmAgent({ apiKey: "k", model: "m", fetchImpl: claude.fetchImpl, newId: () => `p${++n}` }, { system: "s", tools: [createTask] }, "follow up");
    assert.deepEqual(r.proposals, [{ id: "p1", tool: "create_task", input: { summary: "Call Dana" }, summary: "Create task: Call Dana" }]);
    assert.equal(r.steps[0].proposed, true);
    assert.match(claude.requests[1].messages[2].content[0].content, /NOT happened yet/);
  });

  it("reports tool errors to the model instead of crashing", async () => {
    const broken: LlmTool = { ...listDeals, run: () => { throw new Error("database offline"); } };
    const claude = fakeClaude([toolUse("t1", "list_open_deals", {}), final("I couldn't reach the deals.")]);
    const r = await runLlmAgent({ apiKey: "k", model: "m", fetchImpl: claude.fetchImpl }, { system: "s", tools: [broken] }, "q");
    assert.equal(r.steps[0].error, "database offline");
    assert.equal(claude.requests[1].messages[2].content[0].is_error, true);
  });

  it("rejects tools the agent wasn't given", async () => {
    const claude = fakeClaude([toolUse("t1", "delete_everything", {}), final("I can't do that.")]);
    const r = await runLlmAgent({ apiKey: "k", model: "m", fetchImpl: claude.fetchImpl }, { system: "s", tools: [listDeals] }, "q");
    assert.equal(r.steps[0].error, "unknown tool");
  });

  it("stops at the step limit", async () => {
    const claude = fakeClaude([toolUse("a", "list_open_deals", {}), toolUse("b", "list_open_deals", {}), toolUse("c", "list_open_deals", {})]);
    const r = await runLlmAgent({ apiKey: "k", model: "m", fetchImpl: claude.fetchImpl, maxSteps: 2 }, { system: "s", tools: [listDeals] }, "q");
    assert.equal(r.stopReason, "step_limit");
    assert.equal(claude.requests.length, 2);
  });

  it("surfaces API errors with the status code", async () => {
    const claude = fakeClaude([new Response("rate limited", { status: 429 })]);
    await assert.rejects(runLlmAgent({ apiKey: "k", model: "m", fetchImpl: claude.fetchImpl }, { system: "s", tools: [] }, "q"),
      (e: unknown) => e instanceof LlmError && e.status === 429);
  });
});
