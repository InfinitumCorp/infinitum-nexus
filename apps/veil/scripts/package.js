/**
 * Build unpacked Chrome and Firefox trees and zip them.
 *   node scripts/package.js
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromeManifest, firefoxManifest } from "./manifests.js";

const root = fileURLToPath(new URL("../", import.meta.url));

export const EXTENSION_FILES = [
  "THIRD_PARTY_NOTICES.md",
  "background.js",
  "content.js",
  "popup.html",
  "popup.js",
  "sidebar.html",
  "sidebar.js",
  "firm-suite.js",
  "firm-suite.css",
  "lib/ask.js",
  "lib/build.js",
  "lib/blocklist.js",
  "lib/browser-proxy.js",
  "lib/content-pii.js",
  "lib/downloads.js",
  "lib/labyrinth.js",
  "lib/nexus.js",
  "lib/passgen.js",
  "lib/password-guard.js",
  "lib/password-rules.js",
  "lib/privacy.js",
  "lib/proxy.js",
  "lib/safety.js",
  "lib/rewards.js",
  "lib/veil-api.js",
  "lib/workspace.js",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/icon-128.png",
];

export function packageExtension(source = root, outDir = join(source, "dist"), { dev = false } = {}) {
  const version = JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version;
  rmSync(outDir, { recursive: true, force: true });
  const targets = [
    ["chrome", chromeManifest(version), "veil-chrome.zip"],
    ["firefox", firefoxManifest(version), "veil-firefox.zip"],
  ];
  const zips = [];
  for (const [name, manifest, zipName] of targets) {
    const dir = join(outDir, name);
    mkdirSync(dir, { recursive: true });
    for (const file of EXTENSION_FILES) {
      const dest = join(dir, file);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(join(source, file), dest);
    }
    writeFileSync(join(dir, "lib/build.js"), `export const VEIL_DEV = ${dev ? "true" : "false"};\n`);
    writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const zipPath = join(outDir, zipName);
    const zip = spawnSync("zip", ["-r", "-X", zipPath, "."], { cwd: dir, encoding: "utf8" });
    if (zip.status !== 0) throw new Error(zip.stderr || `zip failed for ${name}`);
    zips.push(zipPath);
  }
  return zips;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const zips = packageExtension(root, join(root, "dist"), { dev: process.env.VEIL_DEV === "1" });
  console.log(zips.join("\n"));
}
