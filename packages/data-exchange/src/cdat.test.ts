import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { CdatIssuer, termDurationMs } from "./cdat.ts";

test("term duration parses years and days", () => {
  assert.equal(termDurationMs("CDAT-commercial-1y"), 365 * 24 * 60 * 60 * 1000);
  assert.equal(termDurationMs("CDAT-research-30d"), 30 * 24 * 60 * 60 * 1000);
  assert.equal(termDurationMs("no-duration"), 365 * 24 * 60 * 60 * 1000);
});

test("issue writes license and payment on Firmament", async () => {
  const ledger = new Ledger();
  const signer = generateSigner();
  ledger.authorize(signer.publicKey);
  const issuer = new CdatIssuer(ledger, signer);

  const token = await issuer.issue({
    datasetId: "ds_1",
    saleId: "sale_1",
    licensee: "broker_acme",
    ownerCid: "cid_user",
    terms: "CDAT-commercial-1y",
    amountUsd: 100,
    userShareUsd: 85,
    platformShareUsd: 15,
  });

  assert.equal(token.tokenId, "cdat_1");
  assert.equal(token.onchainId, 1);
  assert.equal(token.amountUsdCents, 10000);
  assert.equal(issuer.isActive(token.tokenId), true);
  assert.ok(token.firmamentTx);
  assert.ok(token.paymentTx);

  assert.equal(issuer.mintIntent(token), null, "no wallet means no mint, not the zero address");
  const wallet = "0x1111111111111111111111111111111111111111";
  const intent = issuer.mintIntent(token, wallet);
  assert.equal(intent?.function, "mint");
  assert.equal(intent?.args.licensee, wallet);
  assert.equal(intent?.args.datasetId, "ds_1");
  assert.equal(intent?.args.amountUsdCents, 10000);

  const entries = await ledger.entries();
  assert.deepEqual(entries.map((e) => e.type), ["license", "payment"]);
  assert.equal((await ledger.verify()).ok, true);

  assert.equal(await issuer.burn(token.tokenId), true);
  assert.equal(issuer.isActive(token.tokenId), false);
  assert.equal((await ledger.entries()).at(-1)?.type, "revoke");
});
