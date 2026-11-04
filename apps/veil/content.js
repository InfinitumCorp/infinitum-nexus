/**
 * VEIL content script.
 * Strips tracking parameters from the current URL and supports privacy messages.
 */
const TRACKERS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid", "msclkid", "igshid", "mc_eid", "ref"];

function stripTrackers(href) {
  try {
    const u = new URL(href);
    let changed = false;
    for (const t of TRACKERS) {
      if (u.searchParams.has(t)) {
        u.searchParams.delete(t);
        changed = true;
      }
    }
    return changed ? u.toString() : null;
  } catch {
    return null;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "cleanUrl") {
    const cleaned = stripTrackers(location.href);
    if (cleaned) {
      history.replaceState(null, "", cleaned);
      sendResponse({ cleaned: true, url: cleaned });
    } else {
      sendResponse({ cleaned: false });
    }
  }
});

// Auto-clean on load (soft)
const cleaned = stripTrackers(location.href);
if (cleaned) {
  console.log("VEIL cleaned URL trackers:", cleaned);
  // history.replaceState would be silent; uncomment for auto
  // history.replaceState(null, "", cleaned);
}
