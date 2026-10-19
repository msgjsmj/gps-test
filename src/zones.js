// Photo zones: where a person stands to photograph a building.
// Derived from footprint + facing so the area data stays the single source.

import { angleDiff, bbox, bearing, dist, normDeg } from './geo.js';

const DEG = Math.PI / 180;

export const ZONE_DEFAULTS = {
  depthPerWidth: 1.2, // depth = depthPerWidth * frontWidth + depthBase, clamped
  depthBase: 8,
  depthMin: 15,
  depthMax: 40,
  sideMargin: 2, // meters added on each side at the building face
  spread: 0.3, // each side widens by spread * depth at the far edge
  maxAlign: 25, // degrees a coarse facing may turn to meet the footprint's own axis
};

// Palace grids are rarely exactly north-aligned. Turn a coarse facing (e.g. 180)
// onto the nearest normal of the footprint's longest edge.
export function alignedFacing(footprint, facingDeg, maxAlign = ZONE_DEFAULTS.maxAlign) {
  let longest = 0, axis = 0;
  for (let i = 0, j = footprint.length - 1; i < footprint.length; j = i++) {
    const len = dist(footprint[j], footprint[i]);
    if (len > longest) [longest, axis] = [len, bearing(footprint[j], footprint[i])];
  }
  const snapped = normDeg(axis + 90 * Math.round(angleDiff(facingDeg, axis) / 90));
  return Math.abs(angleDiff(snapped, facingDeg)) <= maxAlign ? snapped : facingDeg;
}

// One trapezoid per facing bearing, starting at the building's front face.
export function buildZones(building, params = ZONE_DEFAULTS) {
  return building.facing.map((coarse) => {
    const facingDeg = alignedFacing(building.footprint, coarse, params.maxAlign);
    const f = [Math.sin(facingDeg * DEG), Math.cos(facingDeg * DEG)]; // forward
    const l = [f[1], -f[0]]; // to the right of forward
    const along = building.footprint.map((p) => p[0] * f[0] + p[1] * f[1]);
    const across = building.footprint.map((p) => p[0] * l[0] + p[1] * l[1]);
    const front = Math.max(...along);
    const left = Math.min(...across), right = Math.max(...across);
    const width = right - left;
    const depth = Math.min(params.depthMax, Math.max(params.depthMin, params.depthPerWidth * width + params.depthBase));
    const near = params.sideMargin, far = params.sideMargin + params.spread * depth;
    const at = (a, c) => [f[0] * a + l[0] * c, f[1] * a + l[1] * c];
    return [at(front, left - near), at(front, right + near), at(front + depth, right + far), at(front + depth, left - far)];
  });
}

// Attach derived zones and a bounding box once; judge() expects buildings shaped like this.
export function withZones(buildings, params = ZONE_DEFAULTS) {
  return buildings.map((b) => {
    const zones = buildZones(b, params);
    return { ...b, zones, box: bbox([...b.footprint, ...zones.flat()]) };
  });
}
