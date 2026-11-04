import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgent, type Agent } from "./agent.ts";

test("agent calls a tool when the prompt mentions it", async () => {
  const agent: Agent = {
    id: "a1",
    name: "Researcher",
    role: "Build account profiles",
    tools: [{
      name: "search",
      description: "Search for information",
      async execute(input) {
        return { found: true, query: input.prompt };
      },
    }],
  };

  const result = await runAgent(agent, "Please search for Infinitum");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].tool, "search");
  assert.equal((result.toolCalls[0].result as any).found, true);
});

test("agent returns a message when no tool matches", async () => {
  const agent: Agent = {
    id: "a2",
    name: "Assistant",
    role: "Help",
    tools: [],
  };
  const result = await runAgent(agent, "Hello");
  assert.equal(result.toolCalls.length, 0);
  assert.match(String(result.output), /Hello/);
});
