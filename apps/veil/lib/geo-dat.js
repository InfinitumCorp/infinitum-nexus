/**
 * Opt-in geosite categories for VEIL. They add to the curated blocklist and
 * to the VEIL-exit bypass list. They never replace either. .onion names are
 * never bypassed. With the switch off, callers keep the CID exit and Tor path
 * they already had.
 */
import { GEO_RULE_ID, blocklistRules } from "./blocklist.js";
import { decodeGeoSiteList, hostsInCategories, isOnionHost } from "./geo-decode.js";
import { isOnion, safeBypassHosts } from "./proxy.js";

export function extraGeoHosts(bytes, categories, { bypass = false } = {}) {
  if (!bytes || !categories?.length) return [];
  const hosts = hostsInCategories(decodeGeoSiteList(bytes), categories, { rejectOnion: bypass });
  return bypass ? hosts.filter((host) => !isOnionHost(host) && !isOnion(host)) : hosts;
}

/** Curated rules, plus one geosite rule when the switch is on and a category adds hosts. */
export function blocklistWithGeo({ enabled = false, geosite = null, categories = [] } = {}) {
  if (enabled !== true) return blocklistRules();
  const extra = extraGeoHosts(geosite, categories, { bypass: false });
  if (extra.length === 0) return blocklistRules();
  return [
    ...blocklistRules(),
    {
      id: GEO_RULE_ID,
      priority: 1,
      action: { type: "block" },
      condition: {
        requestDomains: extra,
        domainType: "thirdParty",
        excludedResourceTypes: ["main_frame"],
      },
      category: "geo",
    },
  ];
}

/**
 * Tor and a disabled switch return the original bypass hosts. VEIL mode may
 * add geosite domains. Onion names are removed again by safeBypassHosts.
 */
export function bypassForRoute(mode, enabled, baseHosts, extraHosts) {
  if (mode !== "veil" || enabled !== true) return safeBypassHosts(baseHosts);
  return safeBypassHosts([...(baseHosts ?? []), ...(extraHosts ?? [])]);
}
