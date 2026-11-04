import { test } from "node:test";
import assert from "node:assert/strict";
import { actionToScore, executeAction } from "./conductor-bridge.ts";
import type { ExecutionAction } from "./execution.ts";

test("actionToScore creates a valid Score", () => {
  const action: ExecutionAction = {
    dealId: "dl_1",
    type: "notify",
    description: "Re-engage",
    payload: {},
    evidenceHint: "reengage-suggested",
  };
  const score = actionToScore(action);
  assert.ok(score.id);
  assert.equal(score.steps.length, 1);
  assert.equal(score.steps[0].instrument, "spectre-action");
});

test("executeAction returns a performance", async () => {
  const action: ExecutionAction = {
    dealId: "dl_1",
    type: "notify",
    description: "Re-engage",
    payload: {},
    evidenceHint: "reengage-suggested",
  };
  const { performance } = await executeAction(action);
  assert.ok(performance);
  assert.ok(typeof performance.verified === "boolean");
});
