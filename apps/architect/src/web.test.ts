import { test } from "node:test";
import assert from "node:assert/strict";
import { appShellCss, webHtml } from "./web.ts";

test("web app uses the shared app shell with the :\ARCHITECT\ wordmark", () => {
  assert.match(webHtml, /<link rel="stylesheet" href="\/app-shell.css" \/>/);
  assert.ok(webHtml.includes('<a class="app-wordmark" href="/">:\\ARCHITECT\\<sup class="tm">™</sup></a>'));
  assert.doesNotMatch(webHtml, /infinitum/i);
  assert.match(appShellCss, /--ink: #111820;/);
});
