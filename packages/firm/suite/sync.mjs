// Copies firm-suite.js and firm-suite.css into every nexus app listed in copies.json.
// Run from the repo root: node packages/firm/suite/sync.mjs
import { copyFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
for (const dir of JSON.parse(readFileSync(join(here, "copies.json"), "utf8"))) {
  for (const file of ["firm-suite.js", "firm-suite.css"]) copyFileSync(join(here, file), join(root, dir, file));
  console.log(`synced ${dir}`);
}
