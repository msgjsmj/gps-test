import test from 'node:test';
import assert from 'node:assert/strict';
import { bearing, distToPolygon, headingGap, metersPerDegree, pointInPolygon, rotate, toGeo, toLocal } from '../src/geo.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
const square = (cx, cy, h) => [[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h]];

test('meters per degree near Seoul', () => {
  const m = metersPerDegree(37.566);
  close(m.lat, 110988, 5);
  close(m.lng, 88347, 5);
});

test('toLocal and toGeo round-trip, with rotation', () => {
  const placement = { anchor: { lat: 37.566134, lng: 126.975054 }, rotationDeg: 37 };
  const geo = toGeo(placement, [120.5, -80.25]);
  const [x, y] = toLocal(placement, geo);
  close(x, 120.5);
  close(y, -80.25);
});

test('rotation is clockwise in the east/north frame', () => {
  const [x, y] = rotate([0, 1], 90);
  close(x, 1);
  close(y, 0);
});

test('a rotated placement moves local north onto the rotated bearing', () => {
  const placement = { anchor: { lat: 37.5, lng: 127 }, rotationDeg: 90 };
  const g = toGeo(placement, [0, 100]); // 100 m local-north
  close(g.lat, 37.5, 1e-9);
  assert.ok(g.lng > 127); // lands to the east
});

test('bearing', () => {
  close(bearing([0, 0], [1, 0]), 90);
  close(bearing([0, 0], [0, -1]), 180);
  close(bearing([0, 0], [-1, 1]), 315);
});

test('point in polygon and distance to polygon', () => {
  const sq = square(0, 0, 5);
  assert.ok(pointInPolygon([0, 0], sq));
  assert.ok(!pointInPolygon([6, 0], sq));
  close(distToPolygon([0, 0], sq), 0);
  close(distToPolygon([8, 0], sq), 3);
  close(distToPolygon([8, 9], sq), 5);
});

test('heading gap is zero when facing the polygon, angular otherwise', () => {
  const north = square(0, 10, 1);
  close(headingGap([0, 0], north, 0), 0);
  close(headingGap([0, 0], north, 359), 0);
  close(headingGap([0, 0], north, 90), 90 - (Math.atan2(1, 9) * 180) / Math.PI, 1e-9);
  close(headingGap([0, 10], north, 180), 0); // inside
});
