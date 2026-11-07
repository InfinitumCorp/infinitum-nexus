import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromeManifest, firefoxManifest } from "../scripts/manifests.js";
import { EXTENSION_FILES, packageExtension } from "../scripts/package.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const committed = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));

test("the unpacked manifest is the Chrome build and Firefox gets its own proxy permissions", () => {
  assert.deepEqual(committed, chromeManifest(version));
  const firefox = firefoxManifest(version);
  assert.equal(firefox.browser_specific_settings.gecko.id, "veil@infinitum.corporation");
  assert.ok(firefox.permissions.includes("webRequestBlocking"));
  assert.equal(firefox.permissions.includes("webRequestAuthProvider"), false);
  assert.equal(firefox.permissions.includes("sidePanel"), false);
  assert.equal(firefox.side_panel, undefined);
  assert.ok(chromeManifest(version).permissions.includes("webRequestAuthProvider"));
  assert.equal(chromeManifest(version).permissions.includes("webRequestBlocking"), false);
  assert.equal(firefox.action.default_popup, "popup.html");
  assert.equal(firefox.background.service_worker, "background.js");
  assert.match(firefox.description, /not a device-wide VPN/);
  assert.match(firefox.description, /Infinitum Corporation®/);
  const csp = "script-src 'self'; object-src 'self'; worker-src 'self'";
  assert.equal(firefox.content_security_policy.extension_pages, csp);
  assert.equal(chromeManifest(version).content_security_policy.extension_pages, csp);
  assert.deepEqual(chromeManifest(version).host_permissions, ["https://*/*", "http://*/*"]);
  assert.equal(chromeManifest(version).optional_host_permissions, undefined);
});

test("packaging writes Chrome and Firefox zips without the control server or tests", () => {
  const out = mkdtempSync(join(tmpdir(), "veil-pkg-"));
  try {
    const zips = packageExtension(fileURLToPath(new URL("../", import.meta.url)), out);
    assert.equal(zips.length, 2);
    for (const zip of zips) {
      const list = spawnSync("unzip", ["-Z1", zip], { encoding: "utf8" });
      assert.equal(list.status, 0, list.stderr);
      const names = list.stdout.split("\n").filter(Boolean);
      assert.ok(names.includes("manifest.json"));
      assert.ok(names.includes("popup.html"));
      for (const file of EXTENSION_FILES) assert.ok(names.includes(file), file);
      assert.equal(names.some((name) => name.startsWith("server/") || name.startsWith("test/") || name.includes("node_modules")), false);
    }
    const firefoxManifestText = spawnSync("unzip", ["-p", join(out, "veil-firefox.zip"), "manifest.json"], { encoding: "utf8" }).stdout;
    assert.match(firefoxManifestText, /webRequestBlocking/);
    const chromeManifestText = spawnSync("unzip", ["-p", join(out, "veil-chrome.zip"), "manifest.json"], { encoding: "utf8" }).stdout;
    assert.match(chromeManifestText, /webRequestAuthProvider/);
    assert.doesNotMatch(chromeManifestText, /webRequestBlocking/);
    const buildFlag = spawnSync("unzip", ["-p", join(out, "veil-chrome.zip"), "lib/build.js"], { encoding: "utf8" }).stdout;
    assert.match(buildFlag, /VEIL_DEV = false/);
    const devOut = mkdtempSync(join(tmpdir(), "veil-dev-"));
    try {
      packageExtension(fileURLToPath(new URL("../", import.meta.url)), devOut, { dev: true });
      const devFlag = spawnSync("unzip", ["-p", join(devOut, "veil-chrome.zip"), "lib/build.js"], { encoding: "utf8" }).stdout;
      assert.match(devFlag, /VEIL_DEV = true/);
    } finally {
      rmSync(devOut, { recursive: true, force: true });
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
