/**
 * VEIL default blocklist: ad networks, trackers and data brokers.
 *
 * Curated by Infinitum Corporation for VEIL. It is not copied from any
 * third-party filter list. Each entry is a host that serves ads, tracking
 * or audience data across many sites. A host blocks itself and its
 * subdomains. Blocking applies only to third-party subresources, never to
 * the page you opened, so visiting e.g. criteo.com directly still works.
 *
 * The Android app gets the same list (scripts/sync-hub.js generates
 * Blocklist.java). PrivacyTest checks they match.
 */
export const BLOCKLIST = Object.freeze({
  ads: [
    "doubleclick.net", "googlesyndication.com", "googleadservices.com", "adservice.google.com",
    "amazon-adsystem.com", "adnxs.com", "criteo.com", "criteo.net", "taboola.com", "outbrain.com",
    "pubmatic.com", "rubiconproject.com", "openx.net", "casalemedia.com", "adsrvr.org",
    "smartadserver.com", "moatads.com", "yieldmo.com", "sharethrough.com", "teads.tv",
    "33across.com", "indexww.com", "contextweb.com", "lijit.com", "bidswitch.net", "adform.net",
    "mathtag.com", "zemanta.com", "revcontent.com", "mgid.com", "adroll.com", "quantserve.com",
    "media.net", "serving-sys.com", "adsafeprotected.com", "doubleverify.com",
  ],
  trackers: [
    "google-analytics.com", "googletagmanager.com", "analytics.google.com", "app-measurement.com",
    "hotjar.com", "mouseflow.com", "fullstory.com", "mixpanel.com", "mxpnl.com", "segment.io",
    "cdn.segment.com", "api.amplitude.com", "cdn.amplitude.com", "heapanalytics.com", "clarity.ms",
    "nr-data.net", "scorecardresearch.com", "chartbeat.com", "chartbeat.net",
    "connect.facebook.net", "bat.bing.com", "ads-twitter.com", "analytics.twitter.com",
    "px.ads.linkedin.com", "analytics.tiktok.com", "tr.snapchat.com", "ct.pinterest.com",
    "mc.yandex.ru", "alb.reddit.com", "pixel-config.reddit.com",
  ],
  brokers: [
    "bluekai.com", "krxd.net", "exelator.com", "rlcdn.com", "pippio.com", "crwdcntrl.net",
    "tapad.com", "agkn.com", "demdex.net", "everesttech.net", "bounceexchange.com",
    "id5-sync.com", "eyeota.net", "zeotap.com", "intentiq.com", "adsymptotic.com",
  ],
});

export const BLOCKED_HOSTS = Object.freeze([...new Set(Object.values(BLOCKLIST).flat())].sort());

/** True when host is a listed host or one of its subdomains. */
export function isBlockedHost(host) {
  const h = String(host ?? "").toLowerCase().replace(/\.$/, "");
  if (!h) return false;
  return BLOCKED_HOSTS.some((b) => h === b || h.endsWith(`.${b}`));
}

/** Rule IDs 1..N are reserved for the blocklist in dynamic rules. */
export const RULE_ID_BASE = 1000;

/**
 * declarativeNetRequest rules: block listed hosts as third-party
 * subresources. One rule per category keeps getMatchedRules readable.
 */
export function blocklistRules() {
  return Object.entries(BLOCKLIST).map(([category, hosts], i) => ({
    id: RULE_ID_BASE + i,
    priority: 1,
    action: { type: "block" },
    condition: {
      requestDomains: [...hosts],
      domainType: "thirdParty",
      excludedResourceTypes: ["main_frame"],
    },
    // Not part of the DNR schema; stripped before registering.
    category,
  }));
}

export function ruleCategory(ruleId) {
  return Object.keys(BLOCKLIST)[ruleId - RULE_ID_BASE] ?? null;
}
