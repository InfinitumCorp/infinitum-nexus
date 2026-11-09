import { GEO_ROUTING_STORAGE_KEY, geoEnabledFromValue } from "@infinitum/geo-dat";

export { GEO_ROUTING_STORAGE_KEY };

/** The settings button stores "1" or "0". Anything else is off. */
export function spectreGeoEnabled(raw: string | null | undefined) {
  return raw === "1" || geoEnabledFromValue(raw) && raw !== "0";
}
