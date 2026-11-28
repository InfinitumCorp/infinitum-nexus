/**
 * The browser scripts in public/ are plain JavaScript, so nothing checks them before they ship.
 * A name used where it isn't defined throws as soon as that page renders: the People page was
 * blank for weeks because it used the Accounts page's research-queue variables (qStats, queue,
 * recs). This runs the TypeScript checker over each script and fails on any undefined name.
 * It ignores every other kind of type complaint, which plain JavaScript can't satisfy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = join(dirname(fileURLToPath(import.meta.url)), "../..");
const tsc = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin/tsc");
/** "Cannot find name" and "Cannot find name … Did you mean …?" */
const UNDEFINED_NAME = /error TS(2304|2552):/;

test("public browser scripts use no undefined names", () => {
  const scripts = readdirSync(join(app, "public")).filter((f) => f.endsWith(".js")).map((f) => join("public", f));
  assert.ok(scripts.includes(join("public", "app.js")));
  let out = "";
  try {
    execFileSync(process.execPath, [tsc, "--ignoreConfig", "--allowJs", "--checkJs", "--noEmit", "--skipLibCheck", "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler", "--lib", "es2023,dom,dom.iterable", ...scripts], { cwd: app, encoding: "utf8" });
  } catch (e) {
    // tsc exits non-zero for the type complaints this test ignores; its report is on stdout.
    out = String((e as { stdout?: string }).stdout ?? "");
  }
  const undefinedNames = out.split(/\r?\n/).filter((line) => UNDEFINED_NAME.test(line));
  assert.deepEqual(undefinedNames, []);
});
