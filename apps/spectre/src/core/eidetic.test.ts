import { test } from "node:test";
import assert from "node:assert/strict";
import { EIDETIC_NOT_CONFIGURED, matchIdentity, recordConsent } from "./eidetic.ts";

test("ei·det·ic says it is not configured instead of an empty match or a fake consent receipt", async () => {
  const match = await matchIdentity("subject-ref");
  assert.equal(match.configured, false);
  assert.equal(match.error, EIDETIC_NOT_CONFIGURED);
  assert.deepEqual(match.matches, []);
  assert.equal(match.query, "subject-ref");

  const consent = await recordConsent("subject-ref", "support lookup");
  assert.equal(consent.configured, false);
  assert.equal(consent.recorded, false);
  assert.equal(consent.error, EIDETIC_NOT_CONFIGURED);
  assert.equal(consent.purpose, "support lookup");
});
