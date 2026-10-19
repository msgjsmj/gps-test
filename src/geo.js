// Local planar geometry. Local frame: x = east, y = north, in meters,
// relative to a placement anchor. Bearings are degrees clockwise from north.

const DEG = Math.PI / 180;

// Ellipsoidal meters-per-degree at a latitude; accurate well below 1 km spans.
export function metersPerDegree(lat) {
  const p = lat * DEG;
  return {
    lat: 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p),
    lng: 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p),
  };
}

// placement = { anchor: {lat, lng}, rotationDeg } — rotationDeg turns the
// whole layout clockwise around the anchor when it is put on the ground.
export function toLocal(placement, { lat, lng }) {
  const m = metersPerDegree(placement.anchor.lat);
  const wx = (lng - placement.anchor.lng) * m.lng;
  const wy = (lat - placement.anchor.lat) * m.lat;
  return rotate([wx, wy], -(placement.rotationDeg || 0));
}

export function toGeo(placement, point) {
  const [wx, wy] = rotate(point, placement.rotationDeg || 0);
  const m = metersPerDegree(placement.anchor.lat);
  return { lat: placement.anchor.lat + wy / m.lat, lng: placement.anchor.lng + wx / m.lng };
}

// Clockwise rotation in the east/north frame.
export function rotate([x, y], deg) {
  const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG);
  return [x * c + y * s, -x * s + y * c];
}

export function dist([ax, ay], [bx, by]) {
  return Math.hypot(bx - ax, by - ay);
}

export function bearing(from, to) {
  return normDeg(Math.atan2(to[0] - from[0], to[1] - from[1]) / DEG);
}

export function normDeg(d) {
  return ((d % 360) + 360) % 360;
}

// Signed smallest difference a - b, in (-180, 180].
export function angleDiff(a, b) {
  const d = normDeg(a - b);
  return d > 180 ? d - 360 : d;
}

export function pointInPolygon([x, y], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return dist(p, [a[0] + t * dx, a[1] + t * dy]);
}

// 0 when the point is inside the polygon.
export function distToPolygon(p, poly) {
  if (pointInPolygon(p, poly)) return 0;
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) d = Math.min(d, distToSegment(p, poly[j], poly[i]));
  return d;
}

export function bbox(points) {
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

export function distToBox([x, y], box) {
  return Math.hypot(Math.max(box.minX - x, 0, x - box.maxX), Math.max(box.minY - y, 0, y - box.maxY));
}

export function centroid(poly) {
  const n = poly.length;
  return [poly.reduce((s, p) => s + p[0], 0) / n, poly.reduce((s, p) => s + p[1], 0) / n];
}

// Angular gap between a heading and the arc a polygon covers as seen from p.
// 0 when the heading points at the polygon (or p is inside it).
export function headingGap(p, poly, heading) {
  if (pointInPolygon(p, poly)) return 0;
  const center = bearing(p, centroid(poly));
  let lo = 0, hi = 0;
  for (const v of poly) {
    const rel = angleDiff(bearing(p, v), center);
    lo = Math.min(lo, rel);
    hi = Math.max(hi, rel);
  }
  const h = angleDiff(heading, center);
  if (h < lo) return lo - h;
  if (h > hi) return h - hi;
  return 0;
}
