import { test } from "node:test";
import assert from "node:assert/strict";
import { SCALVS_ORIGIN, publicOrigin } from "./origin.ts";

test("SCALVS public origin is the purchased Cloudflare hostname", () => {
  assert.equal(SCALVS_ORIGIN, "https://scalvs.app");
  assert.equal(publicOrigin({}), "https://scalvs.app");
});

test("SCALVS_ORIGIN accepts an http(s) origin and drops a path", () => {
  assert.equal(publicOrigin({ SCALVS_ORIGIN: "http://127.0.0.1:3020/agents" }), "http://127.0.0.1:3020");
  assert.throws(() => publicOrigin({ SCALVS_ORIGIN: "javascript:alert(1)" }), /http\(s\) origin/);
  assert.throws(() => publicOrigin({ SCALVS_ORIGIN: "https://user:secret@scalvs.app" }), /credentials/);
});
