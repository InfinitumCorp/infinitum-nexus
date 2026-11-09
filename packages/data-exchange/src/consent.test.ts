import { test } from "node:test";
import assert from "node:assert/strict";
import { ConsentManager } from "./consent.ts";

test("a product-level grant is found until it is revoked", async () => {
  const cm = new ConsentManager();
  assert.equal(cm.findActive("cid_a", "fabric", "data_licensing"), undefined);

  const c = await cm.grant({ cid: "cid_a", product: "fabric", scopes: ["usage_metrics"], purpose: "data_licensing" });
  assert.equal(cm.findActive("cid_a", "fabric", "data_licensing")?.id, c.id);
  assert.equal(cm.findActive("cid_a", "fabric", "other_purpose"), undefined);
  assert.equal(cm.findActive("cid_b", "fabric", "data_licensing"), undefined);

  assert.equal(await cm.revoke(c.id), true);
  assert.equal(cm.findActive("cid_a", "fabric", "data_licensing"), undefined);
});
