/**
 * Chrome MV3 and Firefox secure-proxy manifests for the same extension sources.
 * Chrome uses webRequestAuthProvider. Firefox uses webRequestBlocking.
 * Neither manifest asks for a device-wide VPN permission.
 */

export const VEIL_GECKO_ID = "veil@infinitum.corporation";

export function extensionDescription() {
  return "Tor for this browser from Infinitum Corporation®. Not Tor Browser fingerprinting protection, and not a device-wide VPN.";
}

const icons = {
  "16": "icons/icon-16.png",
  "32": "icons/icon-32.png",
  "48": "icons/icon-48.png",
  "128": "icons/icon-128.png",
};

function shared(version) {
  return {
    manifest_version: 3,
    name: "VEIL</>",
    version,
    description: extensionDescription(),
    permissions: ["storage", "tabs", "proxy", "privacy", "browsingData", "alarms", "webRequest"],
    host_permissions: ["https://*/*", "http://*/*"],
    action: {
      default_title: "VEIL Tor",
      default_popup: "popup.html",
      default_icon: { "16": icons["16"], "32": icons["32"], "48": icons["48"] },
    },
    icons,
    content_scripts: [
      { matches: ["https://*/*", "http://*/*"], js: ["content.js"], run_at: "document_idle" },
    ],
  };
}

export function chromeManifest(version) {
  const manifest = shared(version);
  manifest.minimum_chrome_version = "116";
  manifest.permissions = [...manifest.permissions, "sidePanel", "webRequestAuthProvider"];
  manifest.background = { service_worker: "background.js", type: "module" };
  manifest.side_panel = { default_path: "sidebar.html" };
  return manifest;
}

export function firefoxManifest(version) {
  const manifest = shared(version);
  manifest.permissions = [...manifest.permissions, "webRequestBlocking"];
  manifest.background = { service_worker: "background.js", type: "module" };
  manifest.browser_specific_settings = {
    gecko: { id: VEIL_GECKO_ID, strict_min_version: "128.0" },
  };
  return manifest;
}
