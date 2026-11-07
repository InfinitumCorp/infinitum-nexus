import { test } from "node:test";
import assert from "node:assert/strict";
import { appShellCss, podiumHtml } from "./podium.ts";

test("podium uses the shared app shell with the :\ARCHITECT\ wordmark", () => {
  assert.match(podiumHtml, /<link rel="stylesheet" href="\/app-shell.css" \/>/);
  assert.ok(podiumHtml.includes('<a class="app-wordmark" href="/">:\\ARCHITECT\\<sup class="tm">™</sup></a>'));
  assert.doesNotMatch(podiumHtml, /infinitum/i);
  assert.match(appShellCss, /--ink: #111820;/);
});
