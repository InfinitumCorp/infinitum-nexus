import { test } from "node:test";
import assert from "node:assert/strict";
import { decideAutonomy } from "./autonomy.ts";
import type { Score } from "./score.ts";

test("rehearsal is dry-run", () => {
  const score: Score = {
    id: "s",
    title: "t",
    intent: "i",
    autonomy: "rehearsal",
    steps: [],
    success: "ok",
    createdAt: new Date().toISOString(),
  };
  const d = decideAutonomy(score, new Set(["rehearsal", "accompaniment", "autopilot"]));
  assert.equal(d.dryRun, true);
  assert.equal(d.shouldExecute, true);
});

test("disallowed autonomy is blocked", () => {
  const score: Score = {
    id: "s",
    title: "t",
    intent: "i",
    autonomy: "autopilot",
    steps: [],
    success: "ok",
    createdAt: new Date().toISOString(),
  };
  const d = decideAutonomy(score, new Set(["rehearsal"]));
  assert.equal(d.shouldExecute, false);
});
