import { test } from "node:test";
import assert from "node:assert/strict";
import { predict } from "./predict.ts";

test("predict returns a probability and factors", () => {
  const p = predict({
    subject: "deal-1",
    features: { stage: "proposal", recentContact: true },
  });
  assert.ok(p.probability > 0 && p.probability < 1);
  assert.ok(p.factors.length > 0);
  assert.equal(p.model, "metatron-default-v1");
});
