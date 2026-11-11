import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { STATIC_ASSET_CSP } from "./static-policy.ts";

test("Worker static CSP matches the live host, including inline styles, and does not loosen scripts", () => {
  assert.equal(
    STATIC_ASSET_CSP,
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );
  assert.doesNotMatch(STATIC_ASSET_CSP, /script-src[^;]*unsafe/);
  assert.match(readFileSync(new URL("./worker.ts", import.meta.url), "utf8"), /STATIC_ASSET_CSP/);
});
