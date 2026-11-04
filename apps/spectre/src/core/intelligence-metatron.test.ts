import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreDealMetatron } from "./intelligence-metatron.ts";
import type { Deal, Activity } from "./model.ts";

test("scoreDealMetatron falls back without env", () => {
  const now = new Date().toISOString();
  const deal: Deal = {
    id: "d1",
    workspace: "demo",
    companyId: "c1",
    name: "Deal",
    market: "commercial",
    stage: "proposal",
    amount: 1000,
    currency: "USD",
    closeDate: "2026-12-01",
    ownerCid: "cid:u",
    contactIds: [],
    stageEnteredAt: now,
    createdAt: now,
    updatedAt: now,
  };
  const s = scoreDealMetatron(deal, [] as Activity[], new Date());
  assert.ok(s.probability >= 0 && s.probability <= 1);
});
