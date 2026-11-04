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

chrome.runtime.onInstalled.addListener(() => {
  console.log("VEIL installed");
  chrome.storage.local.set({ totalVeil: "0", rewardLog: [], torEnabled: false });
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
  sendResponse({ ok: true });
});
