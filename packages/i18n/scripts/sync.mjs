// Copy the canonical runtime files into every app listed in copies.json.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(pkg, "..", "..");
const { copies } = JSON.parse(readFileSync(join(pkg, "copies.json"), "utf8"));
for (const { from, to } of copies) {
  const text = readFileSync(join(pkg, from), "utf8");
  for (const rel of to) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
    console.log(`synced ${rel}`);
  }
}
