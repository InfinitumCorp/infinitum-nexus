/**
 * Local planar geometry in metres (east = x, north = y) around a mission
 * origin. Missions for these platforms span a few kilometres, where a flat
 * frame is accurate enough for fences and energy budgets.
 */
export interface Point {
  x: number;
  y: number;
}

export type Polygon = readonly Point[];

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function pathLength(points: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distance(points[i - 1]!, points[i]!);
  return total;
}

/** Ray-casting point-in-polygon. Points on an edge count as inside. */
export function inside(p: Point, poly: Polygon): boolean {
  if (poly.length < 3) return false;
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (onSegment(p, a, b)) return true;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

function onSegment(p: Point, a: Point, b: Point): boolean {
  const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  if (Math.abs(cross) > 1e-9) return false;
  return Math.min(a.x, b.x) - 1e-9 <= p.x && p.x <= Math.max(a.x, b.x) + 1e-9 &&
    Math.min(a.y, b.y) - 1e-9 <= p.y && p.y <= Math.max(a.y, b.y) + 1e-9;
}

/** Proper or touching intersection of segments ab and cd. */
export function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const o = (p: Point, q: Point, r: Point) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && onSegment(c, a, b)) || (o2 === 0 && onSegment(d, a, b)) ||
    (o3 === 0 && onSegment(a, c, d)) || (o4 === 0 && onSegment(b, c, d));
}

/** Does the leg a→b enter the polygon at any point? */
export function legEntersPolygon(a: Point, b: Point, poly: Polygon): boolean {
  if (inside(a, poly) || inside(b, poly)) return true;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (segmentsIntersect(a, b, poly[j]!, poly[i]!)) return true;
  }
  return false;
}

/** Does the leg a→b stay inside the polygon the whole way? */
export function legInsidePolygon(a: Point, b: Point, poly: Polygon): boolean {
  if (!inside(a, poly) || !inside(b, poly)) return false;
  // Sample the leg: a straight leg between two inside points can still leave
  // a concave fence.
  const steps = Math.max(2, Math.ceil(distance(a, b) / 5));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (!inside({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, poly)) return false;
  }
  return true;
}
