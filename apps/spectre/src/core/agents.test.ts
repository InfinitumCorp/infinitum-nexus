import { test } from "node:test";
import assert from "node:assert/strict";
import { routeQuery, runSpectreAgent, rehearseDeal } from "./agents.ts";

test("routeQuery picks the right agent", () => {
  assert.equal(routeQuery("research Acme"), "researcher");
  assert.equal(routeQuery("find new prospects matching ICP"), "prospector");
  assert.equal(routeQuery("coach me on the next step"), "deal-coach");
  assert.equal(routeQuery("how many open deals?"), "query");
  assert.equal(routeQuery("what is our pipeline?"), "query");
});

test("runSpectreAgent returns a result", async () => {
  const r = await runSpectreAgent("researcher", "research Acme Corp");
  assert.equal(r.agentId, "researcher");
  assert.ok(r.output);
  assert.ok(r.toolCalls.length > 0);
});

test("rehearseDeal returns objections", async () => {
  const r = await rehearseDeal("Acme Corp $50k proposal");
  assert.equal(r.agentId, "deal-coach");
  assert.ok(String(r.output).includes("Price") || r.toolCalls.length > 0);
});
