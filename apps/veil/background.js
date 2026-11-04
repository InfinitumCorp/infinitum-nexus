/**
 * VEIL background service worker.
 * Opens the side panel when the action is clicked.
 * Handles privacy messages and status.
 */
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  console.log("VEIL installed");
  chrome.storage.local.set({ totalVeil: "0", rewardLog: [] });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "status") {
    // Broadcast or store
  }
  sendResponse({ ok: true });
});
