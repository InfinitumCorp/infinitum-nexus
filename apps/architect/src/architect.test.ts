import { test } from "node:test";
import assert from "node:assert/strict";
import { perform, registerInstrument } from "./executor.ts";
import type { Score } from "./score.ts";

test("perform runs a step when permissions are granted", async () => {
  registerInstrument({
    name: "echo",
    async execute(input) {
      return { output: input, evidence: ["echoed"] };
    },
  });

  const score: Score = {
    id: "s1",
    title: "Echo test",
    intent: "echo something",
    autonomy: "autopilot",
    steps: [{
      id: "step1",
      description: "echo",
      instrument: "echo",
      input: { text: "hello" },
      permissions: [{ resource: "echo", actions: ["read"] }],
    }],
    success: "echo returned",
    createdAt: new Date().toISOString(),
  };

  const result = await perform(score, new Set(["echo:read"]));
  assert.equal(result.verified, true);
  assert.equal(result.results[0].ok, true);
  assert.deepEqual(result.results[0].output, { text: "hello" });
});

test("perform blocks a step missing permissions", async () => {
  const score: Score = {
    id: "s2",
    title: "Blocked",
    intent: "should fail",
    autonomy: "rehearsal",
    steps: [{
      id: "step1",
      description: "echo",
      instrument: "echo",
      input: {},
      permissions: [{ resource: "secret", actions: ["write"] }],
    }],
    success: "n/a",
    createdAt: new Date().toISOString(),
  };

  const result = await perform(score, new Set());
  assert.equal(result.verified, false);
  assert.match(result.results[0].error ?? "", /Missing permissions/);
});
