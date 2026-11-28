import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGeoRouting } from "./geo-config.ts";

test("geo routing stays off until the CLI flag is set", () => {
  const dir = mkdtempSync(join(tmpdir(), "geo-app-"));
  assert.equal(loadGeoRouting(dir, {}, ["node", "app"]).enabled, false);
  assert.equal(loadGeoRouting(dir, { INFINITUM_GEO_ENABLED: "1" }, ["node", "app"]).enabled, true);
  assert.equal(loadGeoRouting(dir, {}, ["node", "app", "--no-geo-routing"]).enabled, false);
  assert.equal(loadGeoRouting(dir, { INFINITUM_GEO_ENABLED: "1" }, ["node", "app"]).enabled, false);
});