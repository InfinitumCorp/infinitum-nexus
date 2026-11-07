/**
 * Build unpacked Chrome and Firefox trees and reproducible zip/tar archives.
 *   node scripts/package.js [output-directory]
 *
 * SOURCE_DATE_EPOCH overrides the archive timestamp. When it is unset, the
 * timestamp is the current git commit time. Node is pinned in toolchain.js.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNodeToolchain,
  gitHead,
  packDirectory,
  resolveSourceDateEpoch,
  writeSha256Manifest,
} from "./archive.js";
import { chromeManifest, firefoxManifest } from "./manifests.js";
import { NODE_VERSION, PNPM_VERSION } from "./toolchain.js";

const root = fileURLToPath(new URL("../", import.meta.url));

export const EXTENSION_FILES = [
  "background.js",
  "content.js",
  "popup.html",
  "popup.js",
  "sidebar.html",
  "sidebar.js",
  "lib/ask.js",
  "lib/build.js",
  "lib/browser-proxy.js",
  "lib/labyrinth.js",
  "lib/nexus.js",
  "lib/privacy.js",
  "lib/proxy.js",
  "lib/rewards.js",
  "lib/veil-api.js",
  "lib/workspace.js",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/icon-128.png",
];

export function packageExtension(source = root, outDir = join(source, "dist"), options = {}) {
  assertNodeToolchain();
  if (resolve(outDir) === resolve(source)) throw new Error("refusing to replace the extension source tree");
  const epoch = options.sourceDateEpoch === undefined ? resolveSourceDateEpoch(source) : options.sourceDateEpoch;
  const version = JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version;
  const dev = options.dev === true;
  rmSync(outDir, { recursive: true, force: true });
  const targets = [
    ["chrome", chromeManifest(version), "veil-chrome.zip", "veil-chrome.tar"],
    ["firefox", firefoxManifest(version), "veil-firefox.zip", "veil-firefox.tar"],
  ];
  const zips = [];
  for (const [name, manifest, zipName, tarName] of targets) {
    const dir = join(outDir, name);
    for (const file of EXTENSION_FILES) {
      const dest = join(dir, file);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, readFileSync(join(source, file)));
    }
    writeFileSync(join(dir, "lib/build.js"), `export const VEIL_DEV = ${dev ? "true" : "false"};\n`);
    writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const zipPath = join(outDir, zipName);
    const tarPath = join(outDir, tarName);
    writeFileSync(zipPath, packDirectory(dir, epoch, "zip"));
    writeFileSync(tarPath, packDirectory(dir, epoch, "tar"));
    zips.push(zipPath);
  }
  const commit = options.gitCommit ?? gitHead(source);
  writeFileSync(
    join(outDir, "BUILDINFO"),
    [
      `SOURCE_DATE_EPOCH=${epoch}`,
      `NODE_VERSION=${NODE_VERSION}`,
      `PNPM_VERSION=${PNPM_VERSION}`,
      `GIT_COMMIT=${commit}`,
      "UNSIGNED=1",
      "",
    ].join("\n"),
  );
  writeSha256Manifest(outDir);
  return zips;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ? resolve(process.argv[2]) : join(root, "dist");
  const zips = packageExtension(root, out, { dev: process.env.VEIL_DEV === "1" });
  console.log(zips.join("\n"));
  console.log(join(out, "SHA256SUMS"));
}
