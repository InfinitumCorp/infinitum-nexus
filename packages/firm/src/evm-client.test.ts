import { test } from "node:test";
import assert from "node:assert/strict";
import { createRpcClient, erc20BalanceOf, getBalance, getChainId } from "./evm-client.ts";

test("createRpcClient and helpers shape", async () => {
  const client = createRpcClient("https://example.invalid");
  assert.equal(typeof client.call, "function");
  // We don't hit the network in unit tests; just confirm exports exist.
  assert.equal(typeof erc20BalanceOf, "function");
  assert.equal(typeof getBalance, "function");
  assert.equal(typeof getChainId, "function");
});
