import { test } from "node:test";
import assert from "node:assert/strict";
import { privacyFilter } from "./privacy.ts";

test("privacyFilter redacts email and phone", () => {
  const { cleaned, redactions } = privacyFilter("Contact me at alice@example.com or 555-123-4567");
  assert.ok(cleaned.includes("[redacted-email]"));
  assert.ok(cleaned.includes("[redacted-phone]"));
  assert.ok(redactions.includes("email"));
  assert.ok(redactions.includes("phone"));
});

test("privacyFilter redacts spaced and parenthesized phones", () => {
  const spaced = privacyFilter("Call 555 123 4567 today");
  const paren = privacyFilter("Call (555) 123-4567 today");
  assert.equal(spaced.cleaned.includes("555"), false);
  assert.equal(paren.cleaned.includes("555"), false);
  assert.ok(spaced.redactions.includes("phone"));
  assert.ok(paren.redactions.includes("phone"));
});
