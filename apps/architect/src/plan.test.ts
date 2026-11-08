import assert from "node:assert/strict";
import { test } from "node:test";
import { planScore } from "./plan.ts";

test("planScore builds one research step for the intent", () => {
  const score = planScore("Summarize the launch", "rehearsal");
  assert.equal(score.autonomy, "rehearsal");
  assert.equal(score.intent, "Summarize the launch");
  assert.equal(score.title, "Summarize the launch");
  assert.equal(score.steps.length, 1);
  assert.equal(score.steps[0]?.instrument, "research");
  assert.equal(score.steps[0]?.input.query, "Summarize the launch");
  assert.deepEqual(score.steps[0]?.permissions, [{ resource: "web", actions: ["read"] }]);
  assert.equal(score.success, "research completed");
});
