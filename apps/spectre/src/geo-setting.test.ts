import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { spectreGeoEnabled } from "./geo-setting.ts";

test("the settings switch defaults off and the page has one geo row", () => {
  assert.equal(spectreGeoEnabled(null), false);
  assert.equal(spectreGeoEnabled("0"), false);
  assert.equal(spectreGeoEnabled("1"), true);
  const page = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(page, /id="geo-routing"/);
  assert.match(page, /infinitum\.geoRouting/);
  assert.match(page, /Geo routing data/);
});
