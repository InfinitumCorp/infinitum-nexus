import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateHealth } from "./health.ts";

test("local health is ok", async () => {
  const h = await aggregateHealth();
  assert.equal(h[0].ok, true);
});
