/**
 * Syntax and honesty checks for the VEIL extension. The repo has no ESLint config.
 *   node scripts/lint.js
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromeManifest, extensionDescription } from "./manifests.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const problems = [];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "dist" || name === "node_modules") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

const files = walk(root);
const js = files.filter((path) => path.endsWith(".js"));
for (const path of js) {
  const check = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
  if (check.status !== 0) problems.push(`${path}\n${check.stderr}`);
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const enMessages = JSON.parse(readFileSync(join(root, "_locales/en/messages.json"), "utf8"));
if (enMessages.ext_description?.message !== extensionDescription()) {
  problems.push("_locales/en/messages.json ext_description drifted from scripts/manifests.js extensionDescription()");
}
if (JSON.stringify(manifest) !== JSON.stringify(chromeManifest(pkg.version))) {
  problems.push("manifest.json drifted from scripts/manifests.js chromeManifest()");
}

const runtime = files.filter((path) => {
  if (path.endsWith(`${join("scripts", "lint.js")}`)) return false;
  if (path.includes(`${join("test")}`) || path.endsWith(".test.ts") || path.endsWith("testing.ts")) return false;
  return path.endsWith(".js") || path.endsWith(".ts") || path.endsWith(".html") || path.endsWith(".md");
});
for (const path of runtime) {
  const text = readFileSync(path, "utf8");
  if (/GNU General Public License|GPL-3\.0|SPDX-License-Identifier:\s*GPL/i.test(text)) problems.push(`${path} references a GPL license`);
  if (/BEGIN (?:RSA |OPENSSH )?PRIVATE KEY|AKIA[0-9A-Z]{16}/.test(text)) problems.push(`${path} looks like it contains a secret`);
  if (/\bIT services\b|\bIT department\b|\bIT support\b/.test(text)) problems.push(`${path} describes the service as IT`);
}

const honest = [
  ["popup.html", /not a device-wide VPN/],
  ["popup.html", /Infinitum Corporation®/],
  ["popup.html", /fingerprinting/i],
  ["README.md", /not a device-wide VPN/],
  ["README.md", /this browser/i],
  ["README.md", /fingerprinting/i],
  ["README.md", /IsolateSOCKSAuth/],
];
for (const [name, pattern] of honest) {
  const text = readFileSync(join(root, name), "utf8");
  if (!pattern.test(text)) problems.push(`${name} is missing ${pattern}`);
}

if (problems.length) {
  console.error(problems.join("\n\n"));
  process.exit(1);
}
console.log(`lint ok (${js.length} scripts)`);
