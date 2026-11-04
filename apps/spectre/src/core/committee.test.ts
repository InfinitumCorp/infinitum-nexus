import { test } from "node:test";
import assert from "node:assert/strict";
import { findCommitteeGaps } from "./committee.ts";
import type { Deal, Contact } from "./model.ts";

test("findCommitteeGaps reports missing decision-maker", () => {
  const deal: Deal = {
    id: "dl_1",
    workspace: "demo",
    companyId: "co_1",
    name: "Acme",
    market: "commercial",
    stage: "proposal",
    amount: 10000,
    currency: "USD",
    closeDate: "2026-12-01",
    ownerCid: "cid:u",
    contactIds: ["ct_1"],
    stageEnteredAt: "2026-10-01",
    createdAt: "2026-10-01",
    updatedAt: "2026-10-01",
  };
  const contacts: Contact[] = [
    {
      id: "ct_1",
      workspace: "demo",
      name: "Jane",
      influence: "champion",
      createdAt: "2026-10-01",
      updatedAt: "2026-10-01",
    },
  ];
  const gaps = findCommitteeGaps([deal], contacts);
  assert.equal(gaps.length, 1);
  assert.ok(gaps[0].missing.includes("decision-maker"));
});
