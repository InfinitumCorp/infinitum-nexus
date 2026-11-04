import { test } from "node:test";
import assert from "node:assert/strict";
import { stubEidetic } from "./interface.ts";

test("stubEidetic returns zero confidence", async () => {
  const r = await stubEidetic.query({
    subjectRef: "subj_1",
    purpose: "spectre enrichment",
    requester: "cid:spectre",
  });
  assert.equal(r.confidence, 0);
  assert.equal(r.subjectRef, "subj_1");
});
