import assert from "node:assert/strict";
import { test } from "node:test";
import { entityState, readEntityState } from "./dis.ts";

test("entity state round-trips a platform position", () => {
  const bytes = entityState({ marking: "DAEMON", lat: 47.36559, lon: 8.524997, altM: 120 });
  assert.equal(bytes.byteLength, 144);
  const back = readEntityState(bytes);
  assert.equal(back.marking, "DAEMON");
  assert.ok(Math.abs(back.lat - 47.36559) < 1e-4);
  assert.ok(Math.abs(back.lon - 8.524997) < 1e-4);
  assert.ok(Math.abs(back.altM - 120) < 0.05);
});
