import { consentedSample, geohash, haversineM, type LatLon } from "@infinitum/sense";

/** A harvest fix. It is not created unless the owner opted in. */
export function locationSample(owner: string, consent: string, point: LatLon, origin?: LatLon) {
  return consentedSample(consent, "geo", {
    owner,
    ...point,
    cell: geohash(point),
    metresFromOrigin: origin ? haversineM(origin, point) : 0,
  });
}
