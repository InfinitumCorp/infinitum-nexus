import { test } from "node:test";
import assert from "node:assert/strict";
import { createFirmWallet } from "./wallet.ts";

test("wallet signs a message", async () => {
  const wallet = createFirmWallet({ address: "0xabc" });
  const signed = await wallet.signMessage("hello");
  assert.equal(signed.message, "hello");
  assert.ok(signed.signature.length > 0);
  assert.equal(signed.address, "0xabc");
});

test("wallet builds a transfer payload", () => {
  const wallet = createFirmWallet({ address: "0xabc", chainId: 8453 });
  const tx = wallet.buildTransfer("0xdef", "1000", "0xtoken");
  assert.equal(tx.from, "0xabc");
  assert.equal(tx.chainId, 8453);
  assert.equal(tx.data.method, "transfer");
});
