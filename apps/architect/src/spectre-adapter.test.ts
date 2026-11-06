import { test } from "node:test";
import assert from "node:assert/strict";
import { callSpectre } from "./spectre-adapter.ts";

test("callSpectre handles unreachable", async () => {
  const r = await callSpectre("http://127.0.0.1:1", { path: "/health" });
  assert.equal(r.status, 0);
});
