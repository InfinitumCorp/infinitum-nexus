import { test } from "node:test";
import assert from "node:assert/strict";
import { routeQuery, runSpectreAgent } from "./agents.ts";

test("routeQuery picks the right agent", () => {
  assert.equal(routeQuery("research Acme"), "researcher");
  assert.equal(routeQuery("find new prospects matching ICP"), "prospector");
  assert.equal(routeQuery("coach me on the next step"), "deal-coach");
  assert.equal(routeQuery("how many open deals?"), "query");
});

test("runSpectreAgent returns a result", async () => {
  const r = await runSpectreAgent("researcher", "research Acme Corp");
  assert.equal(r.agentId, "researcher");
  assert.ok(r.output);
});
