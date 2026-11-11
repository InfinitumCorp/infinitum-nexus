import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const pkg = join(import.meta.dirname, "..");
const root = join(pkg, "..", "..");
const { copies } = JSON.parse(readFileSync(join(pkg, "copies.json"), "utf8"));

test("vendored runtime copies match the package (run `pnpm --filter @infinitum/i18n sync`)", () => {
  for (const { from, to } of copies) {
    const want = readFileSync(join(pkg, from), "utf8");
    for (const rel of to) assert.equal(readFileSync(join(root, rel), "utf8"), want, rel);
  }
});
