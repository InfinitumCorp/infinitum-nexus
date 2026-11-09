import { createGeoHook, geoEnabledFromEnv } from "@infinitum/geo-dat";

/** Opt-in lookup. INFINITUM_GEO_ENABLED defaults off. A disabled hook does not read geo data. */
export function geoHook(env: { INFINITUM_GEO_ENABLED?: string } = {}) {
  return createGeoHook({ enabled: geoEnabledFromEnv(env) });
}
