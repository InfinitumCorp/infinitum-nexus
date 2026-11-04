import { test } from "node:test";
import assert from "node:assert/strict";
import { createFirmDex } from "./dex.ts";
import { createRpcClient } from "./evm-client.ts";

test("DEX quote returns a quote", async () => {
  const dex = createFirmDex(createRpcClient("https://example.invalid"), "0xrouter");
  const q = await dex.quote("FIRM", "SPCTR", "1000");
  assert.equal(q.tokenIn, "FIRM");
  assert.equal(q.amountOut, "1000");
});

test("DEX swap returns a tx hash", async () => {
  const dex = createFirmDex(createRpcClient("https://example.invalid"), "0xrouter");
  const r = await dex.swap("FIRM", "SPCTR", "1000", "900");
  assert.ok(r.txHash.startsWith("0xswap_"));
});
