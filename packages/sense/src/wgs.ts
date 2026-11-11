/** WGS84 helpers. Geohash is the public-domain Niemeyer encoding, written here. */

export interface LatLon {
  lat: number;
  lon: number;
}

const M_PER_DEG = 111_320;

export function haversineM(a: LatLon, b: LatLon): number {
  const r = 6_371_000;
  const p1 = (a.lat * Math.PI) / 180;
  const p2 = (b.lat * Math.PI) / 180;
  const dp = ((b.lat - a.lat) * Math.PI) / 180;
  const dl = ((b.lon - a.lon) * Math.PI) / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** East/north metres around an origin. Matches the flat frame used by mission fences. */
export function wgsToLocal(origin: LatLon, point: LatLon): { x: number; y: number } {
  const latRad = (origin.lat * Math.PI) / 180;
  return {
    x: (point.lon - origin.lon) * M_PER_DEG * Math.cos(latRad),
    y: (point.lat - origin.lat) * M_PER_DEG,
  };
}

const GEOHASH = "0123456789bcdefghjkmnpqrstuvwxyz";

export function geohash(point: LatLon, precision = 8): string {
  let minLat = -90;
  let maxLat = 90;
  let minLon = -180;
  let maxLon = 180;
  let hash = "";
  let bit = 0;
  let ch = 0;
  let even = true;
  while (hash.length < precision) {
    if (even) {
      const mid = (minLon + maxLon) / 2;
      if (point.lon >= mid) {
        ch = (ch << 1) | 1;
        minLon = mid;
      } else {
        ch = ch << 1;
        maxLon = mid;
      }
    } else {
      const mid = (minLat + maxLat) / 2;
      if (point.lat >= mid) {
        ch = (ch << 1) | 1;
        minLat = mid;
      } else {
        ch = ch << 1;
        maxLat = mid;
      }
    }
    even = !even;
    bit += 1;
    if (bit === 5) {
      hash += GEOHASH[ch];
      bit = 0;
      ch = 0;
    }
  }
  return hash;
}
