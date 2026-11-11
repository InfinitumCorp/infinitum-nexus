// Extract UI strings from an app's source into <locales dir>/en.json.
//
//   node --experimental-strip-types packages/i18n/scripts/extract.ts --out <locales dir> <file|dir>...
//
// Keys are the English text itself, so the runtime can translate rendered markup
// without code changes. Template-literal and JSX expressions become {0}, {1}…
// placeholders. A heuristic decides what reads like UI copy; extra strings are
// harmless (they only cost a translation), missed ones stay in English.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { extname, join } from "node:path";
import { parseArgs } from "node:util";
import { extractFromSource, mergeCatalog } from "./extract-lib.ts";

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: "string" }, exclude: { type: "string", multiple: true }, prune: { type: "boolean", default: true } },
});
if (!args.out || !positionals.length) {
  console.error("usage: extract.ts --out <locales dir> [--exclude substring]... <file|dir>...");
  process.exit(2);
}
const EXT = new Set([".html", ".js", ".mjs", ".jsx", ".ts", ".tsx"]);
const SKIP_DIR = /(^|[\\/])(node_modules|dist|build|\.git|locales|vendor|coverage|test|tests|__tests__)([\\/]|$)/;
const excludes = args.exclude ?? [];

function* walk(p: string): Generator<string> {
  if (SKIP_DIR.test(p) || excludes.some((x) => p.includes(x))) return;
  const st = statSync(p);
  if (st.isDirectory()) { for (const f of readdirSync(p)) yield* walk(join(p, f)); return; }
  const ext = extname(p);
  if (!EXT.has(ext) || /\.(test|spec|d)\.[jt]sx?$/.test(p) || /i18n[\\/](i18n|catalogs|react)\.js$/.test(p)) return;
  yield p;
}

// The language menu's own label is always needed.
const found = new Set<string>(["Language"]);
let files = 0;
for (const root of positionals) for (const file of walk(root)) {
  files++;
  for (const s of extractFromSource(readFileSync(file, "utf8"), extname(file))) found.add(s);
}

const enPath = join(args.out, "en.json");
const existing = existsSync(enPath) ? JSON.parse(readFileSync(enPath, "utf8")) : {};
const merged = mergeCatalog(existing, [...found], args.prune);
mkdirSync(args.out, { recursive: true });
writeFileSync(enPath, JSON.stringify(merged, null, 2) + "\n");
console.log(`${files} files -> ${Object.keys(merged).length} strings in ${enPath}`);
