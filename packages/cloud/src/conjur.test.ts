import assert from "node:assert/strict";
import { test } from "node:test";
import { conjurResource } from "./conjur.ts";

test("Conjur ids keep the kind and leave the account off", () => {
  assert.deepEqual(conjurResource("variable:db/password"), { kind: "variable", identifier: "db/password" });
  assert.deepEqual(conjurResource("acct:variable:db:password"), { kind: "variable", identifier: "db:password" });
  assert.throws(() => conjurResource("no-colon"), /kind:/);
});
