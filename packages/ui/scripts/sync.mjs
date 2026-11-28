// Copy the canonical app-shell.css and cumulus-bar.js into every app listed in copies.json.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(pkg, "..", "..");
const css = readFileSync(join(pkg, "app-shell.css"), "utf8");
const bar = readFileSync(join(pkg, "cumulus-bar.js"), "utf8");
const { copies, barCopies } = JSON.parse(readFileSync(join(pkg, "copies.json"), "utf8"));
/** .css copies are the file itself; .ts copies export it as a string so bundlers include it. */
export function render(rel, text) {
  if (!rel.endsWith(".ts")) return text;
  return `// Generated from packages/ui/app-shell.css by packages/ui/scripts/sync.mjs. Do not edit.
export const appShellCss = ${JSON.stringify(text)};
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) for (const rel of copies) {
  const target = join(root, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, render(rel, css));
  console.log(`synced ${rel}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) for (const rel of barCopies) {
  const target = join(root, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bar);
  console.log(`synced ${rel}`);
}
