import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateExecution, DEFAULT_RULES } from "./execution.ts";
import type { Deal } from "./model.ts";
import type { Score, NextAction } from "./intelligence.ts";

test("evaluateExecution returns actions for matching rules", () => {
  const deal: Deal = {
    id: "dl_1",
    workspace: "demo",
    companyId: "co_1",
    name: "Acme",
    market: "commercial",
    stage: "proposal",
    amount: 50000,
    currency: "USD",
    closeDate: "2026-12-01",
    ownerCid: "cid:user",
    contactIds: [],
    stageEnteredAt: "2026-10-01",
    createdAt: "2026-10-01",
    updatedAt: "2026-10-01",
  };
  const score: Score = {
    dealId: "dl_1",
    probability: 0.6,
    base: 0.4,
    factors: [{ label: "In touch this week", effect: 1.1 }],
    risk: "low",
  };
  const next: NextAction = {
    dealId: "dl_1",
    action: "Walk the buyer through the proposal live",
    why: "Proposals reviewed together close more often",
    priority: 3,
    channel: "meeting",
  };

  const actions = evaluateExecution(deal, score, next, DEFAULT_RULES);
  assert.ok(actions.length > 0);
  assert.equal(actions[0].type, "create_task");
});
