import { test } from "node:test";
import assert from "node:assert/strict";
import { runAndRecord } from "./architect.ts";
import type { Agent } from "./agent.ts";

test("runAndRecord returns evidence", async () => {
  const agent: Agent = { id: "a1", name: "A", role: "r", tools: [] };
  const e = await runAndRecord(agent, "hello");
  assert.equal(e.agentId, "a1");
  assert.equal(typeof e.verified, "boolean");
});
