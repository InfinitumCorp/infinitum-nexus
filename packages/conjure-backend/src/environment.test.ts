import { test } from "node:test";
import assert from "node:assert/strict";
import { conjureFromEnvironment } from "./environment.ts";
import { setup } from "./testing.ts";
test("missing engine is disabled; configured engine requires CID and persistent integrity key without echoing configuration", async () => {
  const s = await setup();
  assert.equal(conjureFromEnvironment(s.auth, {}), undefined);
  assert.throws(
    () =>
      conjureFromEnvironment(undefined, {
        CONJURE_URL: "https://engine.example",
      }),
    /CID/,
  );
  for (const value of [undefined, "invalid"]) {
    assert.throws(
      () =>
        conjureFromEnvironment(s.auth, {
          CONJURE_URL: "https://engine.example",
          CONJURE_STATE_KEY: value,
        }),
      /persistent/,
    );
  }
});
test("operator plan allowlist is separate and defaults deny; configuration never contacts the engine", async () => {
  const s = await setup(),
    env = {
      CONJURE_URL: "https://engine.example",
      CONJURE_STATE_KEY: "01".repeat(32),
    },
    input = {
      repo: s.owner.repo,
      id: "scenario",
      expectedHead: null,
      consent: true,
      source: { kind: "storage" },
    };
  const denied = conjureFromEnvironment(s.auth, env)!;
  assert.throws(
    () => denied.create(s.owner.token, "firm", input),
    /Independent CONJURE/,
  );
  const allowed = conjureFromEnvironment(s.auth, {
    ...env,
    CONJURE_ENTITLED_ORGS: s.auth.verifiedOrganization(s.owner.token),
  })!;
  assert.equal(allowed.create(s.owner.token, "firm", input).model, "CONJURE");
});
