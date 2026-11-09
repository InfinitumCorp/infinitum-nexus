/**
 * Opt-in geo lookup. Disabled hooks do not decode geo data and do not
 * change routing. INFINITUM_GEO_ENABLED is off unless it is 1, true, on, or yes.
 */
import {
  countryForIP,
  decodeGeoIPList,
  decodeGeoSiteList,
  hostsInCategories,
  isOnionHost,
} from "./decode.js";

export {
  cidrContains,
  countryForIP,
  decodeGeoIPList,
  decodeGeoSiteList,
  hostsInCategories,
  isOnionHost,
  parseIP,
  protobufFields,
} from "./decode.js";

export const GEO_ROUTING_STORAGE_KEY = "infinitum.geoRouting";

export function geoEnabledFromValue(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return text === "1" || text === "true" || text === "on" || text === "yes";
}

export function geoEnabledFromEnv(env = {}) {
  return geoEnabledFromValue(env.INFINITUM_GEO_ENABLED);
}

export function geoFlagFromArgv(argv = []) {
  for (const arg of argv) {
    if (arg === "--geo-routing" || arg === "--geo-routing=true" || arg === "--geo-routing=on" || arg === "--geo-routing=1") {
      return { present: true, enabled: true };
    }
    if (arg === "--no-geo-routing" || arg === "--geo-routing=false" || arg === "--geo-routing=off" || arg === "--geo-routing=0") {
      return { present: true, enabled: false };
    }
  }
  return { present: false, enabled: false };
}

/**
 * CLI flag wins and is what the caller should persist. Otherwise a saved
 * boolean wins over the environment. The default is off.
 */
export function resolveGeoEnabled({ env = {}, argv = [], stored = null } = {}) {
  const flag = geoFlagFromArgv(argv);
  if (flag.present) return flag.enabled;
  if (stored === true || stored === false) return stored;
  return geoEnabledFromEnv(env);
}

export function createGeoHook({ enabled = false, geoip = null, geosite = null } = {}) {
  const on = enabled === true;
  const ipEntries = on && geoip ? decodeGeoIPList(geoip) : null;
  const siteEntries = on && geosite ? decodeGeoSiteList(geosite) : null;
  return {
    enabled: on,
    lookupCountry(ip) {
      if (!ipEntries) return null;
      return countryForIP(ipEntries, ip);
    },
    lookupSite(host) {
      if (!siteEntries) return [];
      const name = String(host ?? "").trim().toLowerCase().replace(/\.$/, "");
      if (!name) return [];
      const codes = [];
      for (const entry of siteEntries) {
        const hosts = hostsInCategories([entry], [entry.code], { rejectOnion: false });
        if (hosts.some((item) => name === item || name.endsWith(`.${item}`))) codes.push(entry.code);
      }
      return codes;
    },
    blockHosts(categories) {
      if (!siteEntries) return [];
      return hostsInCategories(siteEntries, categories, { rejectOnion: false });
    },
    bypassHosts(categories) {
      if (!siteEntries) return [];
      return hostsInCategories(siteEntries, categories, { rejectOnion: true }).filter((host) => !isOnionHost(host));
    },
  };
}
