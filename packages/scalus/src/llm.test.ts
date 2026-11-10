import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { queuedRouter, textReply, toolReply } from "@infinitum/ai/testing";
import { runLlmAgent, LlmError, type LlmTool } from "./llm.ts";

const toolUse = (id: string, name: string, input: Record<string, unknown>) => toolReply([{ id, name, input }], { prompt_tokens: 100, completion_tokens: 20 });
const final = (text: string) => textReply(text, { prompt_tokens: 150, completion_tokens: 40 });

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
    const ai = queuedRouter([toolUse("t1", "list_open_deals", {}), final("Fleet rollout is your best deal at 62%.")]);
    const r = await runLlmAgent({ router: ai.router }, { system: "sys", tools: [listDeals] }, "Which deal is best?");
    assert.equal(r.output, "Fleet rollout is your best deal at 62%.");
    assert.equal(r.steps[0].tool, "list_open_deals");
    assert.equal(r.usage.calls, 2);
    assert.equal(r.usage.inputTokens, 250);
    // The tool result went back to the model in the second request.
    const second = ai.requests[1].messages; // system, user, assistant, tool
    assert.equal(second[3].role, "tool");
    assert.equal(second[3].tool_call_id, "t1");
    assert.match(second[3].content, /Fleet rollout/);
    assert.deepEqual(ai.requests[0].tools.map((t: any) => t.function.name), ["list_open_deals"]);
    assert.ok(!("effect" in ai.requests[0].tools[0].function), "internal fields aren't sent to the API");
  });

  it("queues write actions for human approval instead of running them", async () => {
    const ai = queuedRouter([toolUse("t1", "create_task", { summary: "Call Dana" }), final("I've proposed a task to call Dana; it needs your approval.")]);
    let n = 0;
    const r = await runLlmAgent({ router: ai.router, newId: () => `p${++n}` }, { system: "s", tools: [createTask] }, "follow up");
    assert.deepEqual(r.proposals, [{ id: "p1", tool: "create_task", input: { summary: "Call Dana" }, summary: "Create task: Call Dana" }]);
    assert.equal(r.steps[0].proposed, true);
    assert.match(ai.requests[1].messages[3].content, /NOT happened yet/);
  });

  it("reports tool errors to the model instead of crashing", async () => {
    const broken: LlmTool = { ...listDeals, run: () => { throw new Error("database offline"); } };
    const ai = queuedRouter([toolUse("t1", "list_open_deals", {}), final("I couldn't reach the deals.")]);
    const r = await runLlmAgent({ router: ai.router }, { system: "s", tools: [broken] }, "q");
    assert.equal(r.steps[0].error, "database offline");
    assert.match(ai.requests[1].messages[3].content, /^Error: database offline/);
  });

  it("rejects tools the agent wasn't given", async () => {
    const ai = queuedRouter([toolUse("t1", "delete_everything", {}), final("I can't do that.")]);
    const r = await runLlmAgent({ router: ai.router }, { system: "s", tools: [listDeals] }, "q");
    assert.equal(r.steps[0].error, "unknown tool");
  });

  it("stops at the step limit", async () => {
    const ai = queuedRouter([toolUse("a", "list_open_deals", {}), toolUse("b", "list_open_deals", {}), toolUse("c", "list_open_deals", {})]);
    const r = await runLlmAgent({ router: ai.router, maxSteps: 2 }, { system: "s", tools: [listDeals] }, "q");
    assert.equal(r.stopReason, "step_limit");
    assert.equal(ai.requests.length, 2);
  });

  it("surfaces API errors with the status code", async () => {
    const ai = queuedRouter([new Response("rate limited", { status: 429 })]);
    await assert.rejects(runLlmAgent({ router: ai.router }, { system: "s", tools: [] }, "q"),
      (e: unknown) => e instanceof LlmError && e.status === 429);
  });
});
