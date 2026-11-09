import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeGetAmountsOut, encodeSwapExactTokensForTokens } from "./dex-router.ts";

test("encodeGetAmountsOut starts with selector", () => {
  const data = encodeGetAmountsOut("1000", ["0xaaa", "0xbbb"]);
  assert.ok(data.startsWith("0xd06ca61f"));
});

test("encodeSwap puts the recipient in the address slot", () => {
  const to = "0xcccccccccccccccccccccccccccccccccccccccc";
  const data = encodeSwapExactTokensForTokens("1000", "900", ["0xaaa", "0xbbb"], to, 1_700_000_000);
  assert.ok(data.startsWith("0x38ed1739"));
  const words = data.slice(10).match(/.{64}/g) ?? [];
  assert.equal(words[3], to.slice(2).padStart(64, "0"));
  assert.equal(words[2], "a0".padStart(64, "0"));
});
