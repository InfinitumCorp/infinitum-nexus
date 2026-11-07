import { test } from "node:test";
import assert from "node:assert/strict";
import { DataExchange, ConsentRequiredError } from "./index.ts";

const params = {
  cid: "cid_user", product: "fabric" as const, title: "t", description: "d", schema: "x",
  sizeEstimate: 1, privacyLevel: "aggregated" as const, licenseTerms: "CDAT-test-1y", priceUsd: 10,
  scopes: ["usage_metrics"],
};

test("packaging without consent is refused and creates nothing", async () => {
  const dx = new DataExchange();
  await assert.rejects(dx.packageDataset(params), ConsentRequiredError);
  assert.equal(dx.catalog.list().length, 0);
  assert.equal(dx.consent.findActive("cid_user", "fabric", "data_licensing"), undefined);
});

test("packaging uses the existing consent and revoking it delists", async () => {
  const dx = new DataExchange();
  const c = await dx.consent.grant({ cid: "cid_user", product: "fabric", scopes: ["usage_metrics"], purpose: "data_licensing" });
  const { dataset, consent } = await dx.packageDataset(params);
  assert.equal(consent.id, c.id);
  assert.equal(dataset.consentId, c.id);
  dx.catalog.updateStatus(dataset.id, "listed");
  assert.equal(dx.listForSale().length, 1);

  assert.deepEqual(await dx.revokeConsent(c.id), { revoked: true, delisted: 1 });
  assert.equal(dx.listForSale().length, 0);
  await assert.rejects(dx.packageDataset(params), ConsentRequiredError);
});
