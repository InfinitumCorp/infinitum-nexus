import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreWithMetatron } from "./metatron.ts";
import type { Deal, Activity } from "./model.ts";

test("scoreWithMetatron returns a Score", () => {
  const deal: Deal = {
    id: "deal_1",
    workspace: "demo",
    companyId: "co_1",
    name: "Test",
    stage: "proposal",
    amount: 10000,
    closeDate: "2026-12-01",
    stageEnteredAt: "2026-10-01",
    contactIds: [],
  };
  const activities: Activity[] = [];
  const score = scoreWithMetatron(deal, activities, new Date());
  assert.equal(score.dealId, "deal_1");
  assert.ok(score.probability > 0 && score.probability < 1);
});
