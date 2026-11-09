import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { render } from "../scripts/make-icons.js";

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));

test("renders valid PNGs", () => {
  const png = render(48);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 48);
});

test("every manifest icon exists and is a PNG", () => {
  const paths = [...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)];
  for (const p of paths) {
    assert.match(p, /\.png$/);
    assert.ok(existsSync(new URL(`../${p}`, import.meta.url)), p);
  }
});
