import { test } from "node:test";
import assert from "node:assert/strict";
import { PROJECT_TOKENS, createProjectToken } from "./tokens.ts";

test("PROJECT_TOKENS includes expected symbols", () => {
  const symbols = PROJECT_TOKENS.map((t) => t.symbol);
  assert.ok(symbols.includes("HRVST"));
  assert.ok(symbols.includes("CNDT"));
  assert.ok(symbols.includes("SPCTR"));
  assert.ok(symbols.includes("SCLV"));
});

test("createProjectToken returns a token with methods", () => {
  const token = createProjectToken({
    symbol: "SPCTR",
    name: "Spectre",
    product: "spectre",
    chainId: 8453,
    contractAddress: "0x0000000000000000000000000000000000000000",
    rpcUrl: "https://example.invalid",
  });
  assert.equal(token.symbol, "SPCTR");
  assert.equal(typeof token.balanceOf, "function");
  assert.equal(typeof token.totalSupply, "function");
});
