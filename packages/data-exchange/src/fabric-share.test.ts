import { test } from "node:test";
import assert from "node:assert/strict";
import { DataExchange } from "./index.ts";
import { FabricCollector } from "./collectors.ts";

test("FABRIC datasets pay the contributor 70%", async () => {
  const dx = new DataExchange();
  await dx.consent.grant({ cid: "cid_f", product: "fabric", scopes: ["usage_metrics"], purpose: "data_licensing" });
  const r = await new FabricCollector(dx).collect("cid_f");
  assert.ok(r.datasetId);
  assert.equal(dx.catalog.get(r.datasetId!)!.revSharePct, 70);
  const sale = await dx.sell(r.datasetId!, "broker_acme", 100);
  assert.equal(sale?.userShareUsd, 70);
  assert.equal(sale?.platformShareUsd, 30);
});

test("the FABRIC collector lists nothing without consent", async () => {
  const dx = new DataExchange();
  const r = await new FabricCollector(dx).collect("cid_none");
  assert.deepEqual(r, { skippedReason: "consent_required" });
  assert.equal(dx.listForSale().length, 0);
});
