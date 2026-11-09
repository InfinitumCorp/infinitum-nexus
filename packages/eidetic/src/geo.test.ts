import assert from "node:assert/strict";
import test from "node:test";
import { geoHook } from "./geo.ts";

test("geo routing hook stays off", () => {
  const hook = geoHook({});
  assert.equal(hook.enabled, false);
  assert.equal(hook.lookupCountry("203.0.113.9"), null);
  assert.deepEqual(hook.bypassHosts(["direct"]), []);
});
