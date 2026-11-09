import { test } from "node:test";
import assert from "node:assert/strict";
import { scriptedRouter, textReply } from "../../ai/src/testing.ts";
import { translateContent } from "./content.ts";

test("translateContent sends the text and target language through the router", async () => {
  const { router, requests } = scriptedRouter(() => textReply("Привет"));
  assert.equal(await translateContent("Hello", "ru-RU", { router }), "Привет");
  assert.match(JSON.stringify(requests[0]), /Russian/);
});

test("same language and empty text short-circuit; unknown language throws", async () => {
  const { router } = scriptedRouter(() => { throw new Error("should not call"); });
  assert.equal(await translateContent("Hola", "es", { router, source: "es" }), "Hola");
  assert.equal(await translateContent("  ", "ru", { router }), "  ");
  await assert.rejects(translateContent("x", "ja", { router }), /unsupported/);
});
