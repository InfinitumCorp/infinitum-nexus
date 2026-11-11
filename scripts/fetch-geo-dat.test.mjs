import test from "node:test";
import assert from "node:assert/strict";
import { assertSameHash, parseSha256Sum } from "./fetch-geo-dat.mjs";

test("official sha256sum lines match the lockfile pin", () => {
  const official = parseSha256Sum("eedb24b3b9fcba27e06b92c0428dab90d9496083091ae4cf39e11387fd99d0e2  geoip.dat\n", "geoip.dat");
  assertSameHash("geoip.dat", official, official, "eedb24b3b9fcba27e06b92c0428dab90d9496083091ae4cf39e11387fd99d0e2");
  assert.throws(() => assertSameHash("geoip.dat", "aa", official, official), /SHA-256 mismatch/);
  assert.throws(() => parseSha256Sum("nope\n", "geoip.dat"), /not in the .sha256sum/);
});
