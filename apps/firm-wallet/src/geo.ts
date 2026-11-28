import { createGeoHook, geoEnabledFromEnv } from "@infinitum/geo-dat";

/** Opt-in lookup. The settings switch and INFINITUM_GEO_ENABLED default off. */
export function walletGeo(enabled: boolean, env: { INFINITUM_GEO_ENABLED?: string } = {}) {
  return createGeoHook({ enabled: enabled === true && geoEnabledFromEnv({ INFINITUM_GEO_ENABLED: enabled ? "1" : env.INFINITUM_GEO_ENABLED }) });
}

export function geoRoutingFromPrefs(prefs: { geoRouting?: boolean } | null | undefined) {
  return prefs?.geoRouting === true;
}
