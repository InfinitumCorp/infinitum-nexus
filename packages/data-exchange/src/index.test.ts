import { test } from "node:test";
import assert from "node:assert/strict";
import { DataExchange } from "./index.ts";
import { Ledger, generateSigner } from "@infinitum/firmament";

test("package dataset and sell with rev share and CDAT", async () => {
  const dx = new DataExchange();

  await dx.consent.grant({ cid: "cid_user123", product: "scalus", scopes: ["usage_metrics"], purpose: "data_licensing" });
  const { dataset } = await dx.packageDataset({
    cid: "cid_user123",
    product: "scalus",
    title: "Anonymized agent task patterns",
    description: "Aggregated workflow success rates from SCALVS agents",
    schema: "{agentType, successRate, avgDuration}",
    sizeEstimate: 50000,
    privacyLevel: "aggregated",
    licenseTerms: "CDAT-research-1y",
    priceUsd: 250,
    scopes: ["usage_metrics"],
  });

  assert.equal(dataset.status, "draft");
  dx.catalog.updateStatus(dataset.id, "listed");

  const sale = await dx.sell(dataset.id, "broker_acme", 250);
  assert.ok(sale);
  assert.equal(sale!.userShareUsd, 212.5);
  assert.equal(sale!.platformShareUsd, 37.5);
  assert.equal(sale!.cdatTokenId, "cdat_1");

  const token = dx.cdat.get(sale!.cdatTokenId!);
  assert.ok(token);
  assert.equal(token!.datasetId, dataset.id);
  assert.equal(token!.licensee, "broker_acme");
  assert.equal(token!.terms, "CDAT-research-1y");
  assert.equal(token!.amountUsdCents, 25000);
  assert.equal(dx.cdat.isActive(token!.tokenId), true);
  assert.equal(dx.revshare.pendingForCid("cid_user123"), 212.5);
});

test("a sale needs a positive price and the shares add back up", async () => {
  const dx = new DataExchange();
  await dx.consent.grant({ cid: "cid_user123", product: "scalus", scopes: ["usage_metrics"], purpose: "data_licensing" });
  const { dataset } = await dx.packageDataset({
    cid: "cid_user123",
    product: "scalus",
    title: "Small set",
    description: "Aggregated",
    schema: "x",
    sizeEstimate: 1,
    privacyLevel: "aggregated",
    licenseTerms: "CDAT-research-1y",
    priceUsd: 1,
    scopes: ["usage_metrics"],
  });
  dx.catalog.updateStatus(dataset.id, "listed");
  assert.equal(await dx.sell(dataset.id, "buyer", 0), null);
  assert.equal(await dx.sell(dataset.id, "buyer", -10), null);
  const sale = await dx.sell(dataset.id, "buyer", 0.1);
  assert.ok(sale);
  assert.equal(Math.round((sale!.userShareUsd + sale!.platformShareUsd) * 100), Math.round(sale!.amountUsd * 100));
  assert.equal(dx.catalog.get(dataset.id)?.status, "sold");
});

test("Firmament records consent, license, and payment", async () => {
  const ledger = new Ledger();
  const signer = generateSigner();
  ledger.authorize(signer.publicKey);

  const dx = new DataExchange(ledger, signer);

  await dx.consent.grant({ cid: "cid_firmament", product: "cumulus", scopes: ["usage_metrics"], purpose: "data_licensing" });
  const { dataset, consent } = await dx.packageDataset({
    cid: "cid_firmament",
    product: "cumulus",
    title: "Test dataset",
    description: "Test",
    schema: "x",
    sizeEstimate: 1,
    privacyLevel: "aggregated",
    licenseTerms: "CDAT-test-1y",
    priceUsd: 10,
    scopes: ["usage_metrics"],
  });

  assert.ok(consent.firmamentTx);
  dx.catalog.updateStatus(dataset.id, "listed");
  const sale = await dx.sell(dataset.id, "broker_acme", 10);
  assert.ok(sale?.cdatTokenId);

  const token = dx.cdat.get(sale!.cdatTokenId!);
  assert.ok(token?.firmamentTx);
  assert.ok(token?.paymentTx);

  const entries = await ledger.entries();
  assert.deepEqual(entries.map((e) => e.type), ["grant", "license", "payment"]);
  assert.equal(entries[0].subject, "cumulus");
  assert.equal(entries[1].subject, dataset.id);
  assert.equal((await ledger.verify()).ok, true);
});

test("a ledger failure during the sale leaves the dataset listed", async () => {
  const ledger = new Ledger();
  const signer = generateSigner();
  ledger.authorize(signer.publicKey);
  let signs = 0;
  const flaky = {
    publicKey: signer.publicKey,
    sign(message: string) {
      signs += 1;
      if (signs > 1) throw new Error("ledger down");
      return signer.sign(message);
    },
  };
  const dx = new DataExchange(ledger, flaky);
  await dx.consent.grant({ cid: "cid_user123", product: "scalus", scopes: ["usage_metrics"], purpose: "data_licensing" });
  const { dataset } = await dx.packageDataset({
    cid: "cid_user123",
    product: "scalus",
    title: "Small set",
    description: "Aggregated",
    schema: "x",
    sizeEstimate: 1,
    privacyLevel: "aggregated",
    licenseTerms: "CDAT-research-1y",
    priceUsd: 10,
    scopes: ["usage_metrics"],
  });
  dx.catalog.updateStatus(dataset.id, "listed");
  await assert.rejects(dx.sell(dataset.id, "broker_acme", 10), /ledger down/);
  assert.equal(dx.catalog.get(dataset.id)?.status, "listed");
  assert.equal(dx.marketplace.listSales().length, 0);
  assert.equal(dx.revshare.pendingForCid("cid_user123"), 0);
  assert.equal(dx.cdat.list().length, 0);
});
