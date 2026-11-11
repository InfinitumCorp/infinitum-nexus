import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WORDMARKS, wordmarkHtml, wordmarkText } from "./wordmarks.ts";

test("every product renders with ™", () => {
  for (const w of WORDMARKS) {
    assert.match(wordmarkText(w.id), /™/);
    assert.match(wordmarkHtml(w.id), /<sup class="tm">™<\/sup>/);
  }
});

test("symbols are kept and escaped in HTML", () => {
  assert.equal(wordmarkText("veil"), "VEIL</>™");
  assert.equal(wordmarkHtml("veil"), 'VEIL&lt;/&gt;<sup class="tm">™</sup>');
  assert.equal(wordmarkText("aether-mil"), "ÆTHER™ MIL");
  assert.equal(wordmarkText("metatron"), "METATRON¹⁰⁰™");
});

test("static UI copies of brand.css match the source", () => {
  const src = readFileSync(new URL("../brand.css", import.meta.url), "utf8");
  for (const copy of ["../../../apps/spectre/public/brand.css", "../../../apps/veil/brand.css"]) {
    assert.equal(readFileSync(new URL(copy, import.meta.url), "utf8"), src, `${copy} is stale — run pnpm brand:sync`);
  }
});
