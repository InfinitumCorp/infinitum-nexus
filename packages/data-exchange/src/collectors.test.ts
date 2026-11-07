import { test } from "node:test";
import assert from "node:assert/strict";
import { DataExchange } from "./index.ts";
import { createCollectors } from "./collectors.ts";

test("collectors list only products the person consented to", async () => {
  const dx = new DataExchange();
  const collectors = createCollectors(dx);
  assert.equal(collectors.length, 14);

  const none = await Promise.all(collectors.map((c) => c.collect("cid_testuser")));
  assert.ok(none.every((r) => r.skippedReason === "consent_required"));
  assert.equal(dx.listForSale().length, 0);

  for (const c of collectors) {
    await dx.consent.grant({ cid: "cid_testuser", product: c.product, scopes: ["usage_metrics"], purpose: "data_licensing" });
  }
  const results = await Promise.all(collectors.map((c) => c.collect("cid_testuser")));
  assert.ok(results.every((r) => r.datasetId));
  const products = new Set(dx.listForSale().map((d) => d.product));
  for (const p of ["scalus", "veil", "fabric", "aether", "hrvst", "firm"]) assert.ok(products.has(p as never));
});
