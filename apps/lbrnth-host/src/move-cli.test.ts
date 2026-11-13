import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "./move-cli.ts";

test("move CLI is a dry run unless --apply, and needs --all or --org", () => {
  assert.deepEqual(parseArgs(["--org", "org_1", "--org", "org_2"]), { orgIds: ["org_1", "org_2"], apply: false });
  assert.deepEqual(parseArgs(["--all", "--apply"]), { orgIds: "all", apply: true });
  assert.throws(() => parseArgs([]), /--all or one or more --org/);
  assert.throws(() => parseArgs(["--all", "--org", "x"]), /not both/);
  assert.throws(() => parseArgs(["--org"]), /Unknown argument/);
  assert.throws(() => parseArgs(["--force"]), /Unknown argument/);
});
