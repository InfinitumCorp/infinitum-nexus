import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TRACKERS, stripTrackers } from "../lib/privacy.js";

test("removes tracking parameters and keeps the rest", () => {
  assert.equal(stripTrackers("https://example.com/a?utm_source=x&id=1&fbclid=y#h"), "https://example.com/a?id=1#h");
});

test("returns null when nothing changed or input is not a URL", () => {
  assert.equal(stripTrackers("https://example.com/?id=1"), null);
  assert.equal(stripTrackers("not a url"), null);
});

test("keeps ref, which sites use for real state", () => {
  assert.equal(stripTrackers("https://github.com/o/r/blob/x?ref=main"), null);
});

test("content.js carries the same tracker list", () => {
  const src = readFileSync(new URL("../content.js", import.meta.url), "utf8");
  const block = src.match(/const TRACKERS = \[([\s\S]*?)\];/)[1];
  const list = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(list, [...TRACKERS]);
});
