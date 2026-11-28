import { consentedSample, geohash, haversineM, plusCode, type LatLon } from "@infinitum/sense";

/** A harvest fix. It is not created unless the owner opted in. */
export function locationSample(owner: string, consent: string, point: LatLon, origin?: LatLon) {
  return consentedSample(consent, "geo", {
    owner,
    ...point,
    cell: geohash(point),
    plus: plusCode(point.lat, point.lon),
    metresFromOrigin: origin ? haversineM(origin, point) : 0,
  });
}