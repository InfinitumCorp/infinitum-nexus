/**
 * Chrome MV3 and Firefox secure-proxy manifests for the same extension sources.
 * Chrome uses webRequestAuthProvider. Firefox uses webRequestBlocking.
 * Neither manifest asks for a device-wide VPN permission.
 */

export const VEIL_GECKO_ID = "veil@infinitum.corporation";

/** Store and browser-UI description, translated through _locales (scripts/translate.ts --chrome). */
export const DESCRIPTION_MESSAGE = "__MSG_ext_description__";

export function extensionDescription() {
  return "VEIL VPN and optional Tor for this browser from Infinitum Corporation®. It is not a device-wide VPN.";
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
    name: "VEIL</>™",
    version,
    description: DESCRIPTION_MESSAGE,
    default_locale: "en",
    permissions: ["storage", "tabs", "proxy", "privacy", "browsingData", "alarms", "webRequest",
      // Default-on tracker, ad-network and data-broker blocking (lib/blocklist.js)
      // and the per-site blocked count in the VEIL shield.
      "declarativeNetRequest", "declarativeNetRequestFeedback",
      // Pause risky downloads until the user decides (lib/downloads.js).
      "downloads"],
    // Chrome and Firefox apply proxy.onRequest / chrome.proxy and the content script
    // only to hosts the extension may access. VEIL VPN and Tor must cover every
    // http(s) page in this browser, so these two patterns stay required.
    // optional_host_permissions would leave those pages on the ordinary network
    // until a later grant, which breaks fail-closed routing.
    host_permissions: ["https://*/*", "http://*/*"],
    // MV3 allows only script-src, object-src, and worker-src on extension pages.
    // Firefox uses the same extension_pages key. No eval and no remote scripts.
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'; worker-src 'self'",
    },
    action: {
      default_title: "VEIL Tor",
      default_popup: "popup.html",
      default_icon: { "16": icons["16"], "32": icons["32"], "48": icons["48"] },
    },
    icons,
    content_scripts: [
      { matches: ["https://*/*", "http://*/*"], js: ["lib/content-pii.js", "content.js"], run_at: "document_idle" },
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
