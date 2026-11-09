/**
 * Emit JavaScript for the SCALVS runtime.
 * Source imports end in .ts so Node can run them directly. The emitted files
 * use .js specifiers, which Node loads from dist/.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import * as ts from "typescript";

const packageRoot = join(import.meta.dirname, "..");
const srcDir = join(packageRoot, "src");
const outDir = join(packageRoot, "dist");

const options: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  verbatimModuleSyntax: true,
};

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) found.push(path);
  }
  return found;
}

function rewriteSpecifiers(js: string): string {
  return js.replace(/(["'])(\.{1,2}\/[^"']+?)\.ts\1/g, "$1$2.js$1");
}

rmSync(outDir, { recursive: true, force: true });
let failed = false;
let count = 0;

for (const file of sourceFiles(srcDir)) {
  const source = readFileSync(file, "utf8");
  const result = ts.transpileModule(source, { compilerOptions: options, fileName: file, reportDiagnostics: true });
  const errors = (result.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    failed = true;
    for (const diagnostic of errors) {
      const where = diagnostic.file && diagnostic.start !== undefined
        ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
        : undefined;
      const line = where ? `:${where.line + 1}` : "";
      console.error(`${file}${line}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`);
    }
    continue;
  }
  const js = rewriteSpecifiers(result.outputText);
  if (/(?:from\s+|import\s*\(\s*)["']\.{1,2}\/[^"']+\.ts["']/.test(js)) {
    failed = true;
    console.error(`${file}: a relative import still ends in .ts`);
    continue;
  }
  const dest = join(outDir, relative(srcDir, file).replace(/\.ts$/, ".js"));
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, js);
  count++;
}

if (failed) process.exit(1);
console.log(`built ${count} files into ${outDir}`);
