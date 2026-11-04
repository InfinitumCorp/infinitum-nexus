import { test } from "node:test";
import assert from "node:assert/strict";
import { deploy } from "./deploy.ts";

test("deploy returns firm and project addresses", async () => {
  const r = await deploy("http://localhost:8545", "");
  assert.ok(r.firm.startsWith("0x"));
  assert.ok(r.projects.SPCTR);
  assert.ok(r.projects.HRVST);
});
