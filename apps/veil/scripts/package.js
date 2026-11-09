/**
 * Build unpacked Chrome and Firefox trees and reproducible zip/tar archives.
 *   node scripts/package.js [output-directory]
 *
 * SOURCE_DATE_EPOCH overrides the archive timestamp. When it is unset, the
 * timestamp is the current git commit time. Node is pinned in toolchain.js.
 */
import { spawnSync } from "node:child_process";
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
  "THIRD_PARTY_NOTICES.md",
  "background.js",
  "content.js",
  "popup.html",
  "popup.js",
  "sidebar.html",
  "sidebar.js",
  "firm-suite.js",
  "firm-suite.css",
  // Interface language (@infinitum/i18n): runtime and build-time catalogs, no model calls.
  "i18n/i18n.js",
  "i18n/i18n.css",
  "i18n/start.js",
  "i18n/catalogs.js",
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
  "lib/region.js",
  "lib/region-blocks.js",
  "lib/safety.js",
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

/** Windows' built-in bsdtar, used to read zip archives where Info-ZIP is not installed. */
export const WINDOWS_TAR = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : null;

export function hasCommand(cmd) {
  const r = spawnSync(cmd, ["-v"], { encoding: "utf8" });
  return !r.error;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ? resolve(process.argv[2]) : join(root, "dist");
  const zips = packageExtension(root, out, { dev: process.env.VEIL_DEV === "1" });
  console.log(zips.join("\n"));
  console.log(join(out, "SHA256SUMS"));
}
