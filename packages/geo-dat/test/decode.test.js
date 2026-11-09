import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGeoHook, geoEnabledFromEnv, resolveGeoEnabled } from "../src/index.js";
import { applyGeoCli, readStoredGeo } from "../src/node.js";
import { sampleGeoIP, sampleGeoSite } from "./fixture.js";

test("a disabled hook ignores geo bytes and the environment default is off", () => {
  const hook = createGeoHook({ enabled: false, geoip: sampleGeoIP(), geosite: sampleGeoSite() });
  assert.equal(hook.enabled, false);
  assert.equal(hook.lookupCountry("203.0.113.9"), null);
  assert.deepEqual(hook.blockHosts(["category-ads"]), []);
  assert.deepEqual(hook.bypassHosts(["direct"]), []);
  assert.equal(geoEnabledFromEnv({}), false);
  assert.equal(geoEnabledFromEnv({ INFINITUM_GEO_ENABLED: "0" }), false);
  assert.equal(geoEnabledFromEnv({ INFINITUM_GEO_ENABLED: "yes" }), true);
  assert.equal(resolveGeoEnabled({ stored: false, env: { INFINITUM_GEO_ENABLED: "1" } }), false);
  assert.equal(resolveGeoEnabled({ argv: ["--geo-routing"], stored: false }), true);
  assert.equal(resolveGeoEnabled({ argv: ["--no-geo-routing"], env: { INFINITUM_GEO_ENABLED: "1" } }), false);
});

test("an enabled hook reads synthetic v2fly lists and never bypasses onion names", () => {
  const hook = createGeoHook({ enabled: true, geoip: sampleGeoIP(), geosite: sampleGeoSite() });
  assert.equal(hook.lookupCountry("203.0.113.9"), "ZZ");
  assert.equal(hook.lookupCountry("198.51.100.8"), null);
  assert.equal(hook.lookupCountry("192.0.2.1"), null);
  assert.deepEqual(hook.blockHosts(["category-ads"]), ["tracker.example"]);
  assert.deepEqual(hook.bypassHosts(["direct"]), ["direct.example"]);
  assert.equal(hook.bypassHosts(["direct"]).some((host) => host.includes("onion")), false);
  assert.deepEqual(hook.lookupSite("a.tracker.example"), ["category-ads"]);
  assert.deepEqual(hook.blockHosts([]), []);
});

test("the CLI flag is persisted and a missing file stays off", () => {
  const dir = mkdtempSync(join(tmpdir(), "geo-dat-"));
  const path = join(dir, "geo-routing.json");
  assert.equal(readStoredGeo(path), null);
  const off = applyGeoCli({ path, argv: ["node", "app"], env: {} });
  assert.equal(off.enabled, false);
  assert.equal(readStoredGeo(path), null);
  const on = applyGeoCli({ path, argv: ["node", "app", "--geo-routing=on"], env: {} });
  assert.equal(on.enabled, true);
  assert.equal(readFileSync(path, "utf8").includes('"enabled": true') || readFileSync(path, "utf8").includes('"enabled":true'), true);
  const again = applyGeoCli({ path, argv: ["node", "app"], env: { INFINITUM_GEO_ENABLED: "0" } });
  assert.equal(again.enabled, true);
});
