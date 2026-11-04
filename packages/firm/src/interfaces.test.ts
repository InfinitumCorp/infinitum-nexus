import { test } from "node:test";
import assert from "node:assert/strict";
import type { FirmToken, FirmWallet } from "./interfaces.ts";

test("FIRM interfaces are exported as types", () => {
  // Type-level smoke test: the interfaces exist and can be referenced.
  const tokenShape: Partial<FirmToken> = { symbol: "FIRM" };
  assert.equal(tokenShape.symbol, "FIRM");
});
