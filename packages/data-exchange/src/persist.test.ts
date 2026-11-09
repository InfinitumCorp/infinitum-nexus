import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataExchange } from "./index.ts";
import { Ledger, generateSigner } from "@infinitum/firmament";

test("snapshot reloads sales, CDAT tokens, and settled payouts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dx-"));
  const file = join(dir, "exchange.json");
  const ledger = new Ledger();
  const signer = generateSigner();
  ledger.authorize(signer.publicKey);

  const dx = new DataExchange(ledger, signer, file);
  await dx.consent.grant({ cid: "cid_user123", product: "scalus", scopes: ["usage_metrics"], purpose: "data_licensing" });
  const { dataset } = await dx.packageDataset({
    cid: "cid_user123",
    product: "scalus",
    title: "Agent aggregates",
    description: "Aggregated",
    schema: "x",
    sizeEstimate: 10,
    privacyLevel: "aggregated",
    licenseTerms: "CDAT-commercial-1y",
    priceUsd: 100,
    scopes: ["usage_metrics"],
  });
  dx.catalog.updateStatus(dataset.id, "listed");
  const sale = await dx.sell(
    dataset.id,
    "broker_acme",
    100,
    "0x1111111111111111111111111111111111111111",
  );
  assert.ok(sale);
  await dx.flush();

  const again = new DataExchange(ledger, signer, file);
  await again.load();
  assert.equal(again.catalog.get(dataset.id)?.status, "sold");
  const token = again.cdat.get(sale!.cdatTokenId!);
  assert.equal(token?.licenseeAddress, "0x1111111111111111111111111111111111111111");
  assert.equal(again.revshare.pendingForCid("cid_user123"), 85);
  assert.ok(again.mintCalldata(token!.tokenId)?.startsWith("0x01d47bed"));

  const payout = await again.settlePayout(sale!.id);
  assert.equal(payout?.paid, true);
  await again.flush();

  const third = new DataExchange(undefined, undefined, file);
  await third.load();
  assert.equal(third.revshare.pendingForCid("cid_user123"), 0);
  assert.equal(third.cdat.exportState().nextOnchainId, 2);
});
