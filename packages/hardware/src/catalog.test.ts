import { test } from "node:test";
import assert from "node:assert/strict";
import { HARDWARE_CATALOG, checkedTask, filterTelemetry } from "./catalog.ts";

test("DAEMON and SLUG are in the catalog with MIL editions", () => {
  assert.equal(HARDWARE_CATALOG.DAEMON.domain, "air");
  assert.equal(HARDWARE_CATALOG.SLUG.domain, "land");
  assert.ok(HARDWARE_CATALOG.DAEMON.hasMilEdition && HARDWARE_CATALOG.SLUG.hasMilEdition);
});

test("every approval-gated command is a real command", () => {
  for (const p of Object.values(HARDWARE_CATALOG)) {
    for (const c of p.approvalRequired) assert.ok(p.commands.includes(c), `${p.id}: ${c}`);
  }
});

test("checkedTask accepts known commands and flags approval", () => {
  assert.equal(checkedTask("DAEMON", "launch").needsApproval, true);
  assert.equal(checkedTask("DAEMON", "return_to_base").needsApproval, false);
  assert.equal(checkedTask("SLUG", "patrol_route").needsApproval, true);
  assert.equal(checkedTask("SLUG", "stop").product, "SLUG");
});

test("checkedTask rejects commands a product does not accept", () => {
  assert.throws(() => checkedTask("SLUG", "launch"), /does not accept/);
});

test("telemetry is filtered to declared fields", () => {
  assert.deepEqual(filterTelemetry("SLUG", { speedMs: 2, batteryPct: 80, cameraFrame: "..." }), {
    speedMs: 2,
    batteryPct: 80,
  });
});
