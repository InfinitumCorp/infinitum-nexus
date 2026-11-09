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

test("DEX swap pays the recipient, not the zero address", async () => {
  const dex = createFirmDex(createRpcClient("https://example.invalid"), "0xrouter");
  const to = "0x1111111111111111111111111111111111111111";
  const r = await dex.swap("FIRM", "SPCTR", "1000", "900", to);
  assert.ok(r.txHash.startsWith("0xswap_"));
  const words = r.data.slice(10).match(/.{64}/g) ?? [];
  assert.equal(words[3], to.slice(2).padStart(64, "0"));
});
