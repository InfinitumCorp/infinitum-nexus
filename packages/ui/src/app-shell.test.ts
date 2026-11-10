import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "../scripts/sync.mjs";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(pkg, "..", "..");
const css = readFileSync(join(pkg, "app-shell.css"), "utf8");
const { copies } = JSON.parse(readFileSync(join(pkg, "copies.json"), "utf8")) as { copies: string[] };

test("uses exactly the RULES palette", () => {
  const hexes = new Set((css.match(/#[0-9a-f]{3,8}\b/gi) ?? []).map((h) => h.toLowerCase()));
  assert.deepEqual([...hexes].sort(), ["#111820", "#2454dd", "#52606b", "#d6dce1", "#ffffff"]);
});

test("has no gradients, shadows or glows", () => {
  const body = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(body, /gradient\(/);
  assert.doesNotMatch(body, /box-shadow|text-shadow|drop-shadow/);
});

test("headings are weight 400 and the font is the system Helvetica stack", () => {
  assert.match(css, /:where\(h1, h2, h3, h4\) \{ font-weight: 400;/);
  assert.match(css, /--font: 'Helvetica Neue', Helvetica, Arial, sans-serif;/);
  assert.doesNotMatch(css, /@import|@font-face/);
});

test("trademark mark matches the live site", () => {
  assert.match(css, /sup\.tm \{ font-size: \.38em; vertical-align: super; line-height: 0; margin-left: \.08em;/);
});

for (const rel of copies) {
  test(`vendored copy is identical: ${rel}`, () => {
    const path = join(root, rel);
    assert.ok(existsSync(path), `${rel} is missing; run the sync script`);
    assert.equal(readFileSync(path, "utf8"), render(rel, css), `${rel} drifted; run the sync script`);
  });
}
