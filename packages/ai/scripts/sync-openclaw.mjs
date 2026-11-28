#!/usr/bin/env node
// Copies the OpenClaw client into another repo: node packages/ai/scripts/sync-openclaw.mjs <dest-folder>
// The destination gets openclaw.mjs, openclaw.d.mts and README.md. Don't edit those copies.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dest = process.argv[2];
if (!dest) {
  console.error("usage: sync-openclaw.mjs <dest-folder>");
  process.exit(1);
}
const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "openclaw");
mkdirSync(dest, { recursive: true });
for (const f of ["openclaw.mjs", "openclaw.d.mts", "README.md"]) copyFileSync(join(src, f), join(dest, f));
console.log(`OpenClaw client synced to ${dest}`);
