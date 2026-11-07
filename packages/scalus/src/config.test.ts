import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ORIGIN, loadConfig } from "./config.ts";

test("PORT and origin default to 3020 and https://scalvs.app", () => {
  const config = loadConfig({});
  assert.equal(config.port, 3020);
  assert.equal(config.origin, DEFAULT_ORIGIN);
  assert.equal(config.origin, "https://scalvs.app");
});

test("blank PORT and SCALVS_ORIGIN keep the defaults", () => {
  const config = loadConfig({ PORT: "  ", SCALVS_ORIGIN: "" });
  assert.equal(config.port, 3020);
  assert.equal(config.origin, "https://scalvs.app");
});

test("PORT and SCALVS_ORIGIN are configurable", () => {
  const config = loadConfig({ PORT: "0", SCALVS_ORIGIN: "http://localhost:3020/" });
  assert.equal(config.port, 0);
  assert.equal(config.origin, "http://localhost:3020");
});

test("a path on SCALVS_ORIGIN is not part of the origin", () => {
  assert.equal(loadConfig({ SCALVS_ORIGIN: "https://scalvs.app/agents" }).origin, "https://scalvs.app");
});

test("PORT must be an integer from 0 to 65535", () => {
  assert.throws(() => loadConfig({ PORT: "nope" }), /PORT/);
  assert.throws(() => loadConfig({ PORT: "65536" }), /PORT/);
  assert.throws(() => loadConfig({ PORT: "-1" }), /PORT/);
});

test("SCALVS_ORIGIN must be an http(s) URL without credentials", () => {
  assert.throws(() => loadConfig({ SCALVS_ORIGIN: "*" }), /SCALVS_ORIGIN/);
  assert.throws(() => loadConfig({ SCALVS_ORIGIN: "ftp://scalvs.app" }), /SCALVS_ORIGIN/);
  assert.throws(() => loadConfig({ SCALVS_ORIGIN: "https://user:secret@scalvs.app" }), /credentials/);
});
