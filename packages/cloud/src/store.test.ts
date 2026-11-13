import { test } from "node:test";
import assert from "node:assert/strict";
import { CloudStore } from "./store.ts";

test("put and get", async () => {
  const s = new CloudStore();
  await s.put("a.txt", "cid:user", 100);
  assert.equal(s.get("a.txt")?.owner, "cid:user");
});
