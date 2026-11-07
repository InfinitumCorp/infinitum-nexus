import { test } from "node:test";
import assert from "node:assert/strict";
import { CNDCTR_ORIGIN, publicOrigin } from "./config.ts";

test("CNDCTR public origin is the purchased Cloudflare hostname", () => {
  assert.equal(CNDCTR_ORIGIN, "https://cndctr.app");
  assert.equal(publicOrigin({}), "https://cndctr.app");
});

test("CNDCTR_ORIGIN accepts an http(s) origin and drops a path", () => {
  assert.equal(publicOrigin({ CNDCTR_ORIGIN: "http://127.0.0.1:3001/podium" }), "http://127.0.0.1:3001");
  assert.throws(() => publicOrigin({ CNDCTR_ORIGIN: "javascript:alert(1)" }), /http\(s\) origin/);
  assert.throws(() => publicOrigin({ CNDCTR_ORIGIN: "https://user:secret@cndctr.app" }), /credentials/);
});
