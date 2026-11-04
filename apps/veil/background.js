/**
 * VEIL background service worker.
 * Opens side panel, manages Tor proxy via chrome.proxy, storage.
 */
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

const TOR_HOST = "127.0.0.1";
const TOR_PORT = 9050;

async function setTorProxy(enabled) {
  if (enabled) {
    const config = {
      mode: "fixed_servers",
      rules: {
        singleProxy: {
          scheme: "socks5",
          host: TOR_HOST,
          port: TOR_PORT
        },
        bypassList: ["localhost", "127.0.0.1", "<local>"]
      }
    };
    await chrome.proxy.settings.set({ value: config, scope: "regular" });
    await chrome.storage.local.set({ torEnabled: true });
    return true;
  } else {
    await chrome.proxy.settings.clear({ scope: "regular" });
    await chrome.storage.local.set({ torEnabled: false });
    return false;
  }
}

async function checkTor() {
  try {
    const r = await fetch("https://check.torproject.org/api/ip", { cache: "no-store" });
    const data = await r.json();
    return !!data.IsTor;
  } catch {
    return false;
  }
}

async function loadDeployed() {
  try {
    const url = chrome.runtime.getURL("deployed.json");
    const r = await fetch(url);
    const cfg = await r.json();
    if (cfg.veilClaim) {
      await chrome.storage.local.set({ veilClaim: cfg.veilClaim, firmRpc: cfg.rpc || "https://mainnet.base.org" });
    }
  } catch {
    // deployed.json missing or invalid — ignore
  }
}

chrome.runtime.onInstalled.addListener(() => {
  console.log("VEIL installed");
  chrome.storage.local.set({ totalVeil: "0", rewardLog: [], torEnabled: false, autoClean: false });
  loadDeployed();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "toggleTor") {
    setTorProxy(msg.enabled).then(enabled => sendResponse({ enabled }));
    return true;
  }
  if (msg.type === "getTorStatus") {
    chrome.storage.local.get(["torEnabled"], (s) => sendResponse({ enabled: !!s.torEnabled }));
    return true;
  }
  if (msg.type === "checkTor") {
    checkTor().then(isTor => sendResponse({ isTor }));
    return true;
  }
  if (msg.type === "setAutoClean") {
    chrome.storage.local.set({ autoClean: !!msg.enabled }, () => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "reloadDeployed") {
    loadDeployed().then(() => sendResponse({ ok: true }));
    return true;
  }
  sendResponse({ ok: true });
});
