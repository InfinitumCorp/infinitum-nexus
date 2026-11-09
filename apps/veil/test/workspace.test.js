import { test } from "node:test";
import assert from "node:assert/strict";
import { ANONYMOUS, AUTHENTICATED, can, normalize, planSwitch, SITE_DATA_TYPES } from "../lib/workspace.js";

test("anonymous workspace has no AI, wallet, sign-in, sync or rewards", () => {
  for (const cap of ["ai", "wallet", "signin", "sync", "rewards"]) assert.equal(can(ANONYMOUS, cap), false, cap);
  for (const cap of ["tor", "trackers", "newIdentity"]) assert.equal(can(ANONYMOUS, cap), true, cap);
});

test("signed-in workspace unlocks the ecosystem", () => {
  for (const cap of ["ai", "wallet", "signin", "rewards", "tor"]) assert.equal(can(AUTHENTICATED, cap), true, cap);
});

test("unknown workspace values fail closed to anonymous", () => {
  assert.equal(normalize(undefined), ANONYMOUS);
  assert.equal(normalize("admin"), ANONYMOUS);
  assert.equal(can("admin", "wallet"), false);
});

test("every switch clears site data and warns", () => {
  for (const [from, to] of [[ANONYMOUS, AUTHENTICATED], [AUTHENTICATED, ANONYMOUS]]) {
    const p = planSwitch(from, to);
    assert.equal(p.clearSiteData, true);
    assert.ok(p.warning.length > 20);
  }
  assert.match(planSwitch(ANONYMOUS, AUTHENTICATED).warning, /not anonymous/);
  assert.equal(planSwitch(ANONYMOUS, ANONYMOUS), null);
  assert.throws(() => planSwitch(ANONYMOUS, "root"));
});

test("site-data clearing leaves history, passwords and downloads alone", () => {
  for (const kept of ["history", "passwords", "downloads", "formData"]) assert.equal(SITE_DATA_TYPES[kept], undefined);
  assert.equal(SITE_DATA_TYPES.cookies, true);
});
