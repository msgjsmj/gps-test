import test from 'node:test';
import assert from 'node:assert/strict';
import { pointInPolygon, rotate } from '../src/geo.js';
import { JUDGE_DEFAULTS, judge, samplePoints, sigmaFor } from '../src/judge.js';
import { alignedFacing, buildZones, withZones } from '../src/zones.js';

const square = (cx, cy, h) => [[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h]];
const close = (a, b, eps) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test('zone sits in front of the facing side and widens away from it', () => {
  const [zone] = buildZones({ footprint: square(0, 0, 5), facing: [180] });
  // width 10 → depth 1.2*10+8 = 20; face at y=-5, far edge at y=-25
  assert.ok(pointInPolygon([0, -10], zone));
  assert.ok(pointInPolygon([12, -24], zone)); // widened far edge (±13)
  assert.ok(!pointInPolygon([12, -6], zone)); // narrow near edge (±7)
  assert.ok(!pointInPolygon([0, 10], zone)); // behind the building
  assert.ok(!pointInPolygon([0, -27], zone));
});

test('one zone per facing direction', () => {
  const zones = buildZones({ footprint: square(0, 0, 5), facing: [90, 270] });
  assert.equal(zones.length, 2);
  assert.ok(pointInPolygon([10, 0], zones[0]));
  assert.ok(pointInPolygon([-10, 0], zones[1]));
});

test('a coarse facing turns onto a rotated footprint axis, but not too far', () => {
  const tilted = [[-10, -4], [10, -4], [10, 4], [-10, 4]].map((p) => rotate(p, 10));
  close(alignedFacing(tilted, 180), 190, 1e-9);
  close(alignedFacing(tilted, 90), 100, 1e-9);
  const skewed = [[-10, -4], [10, -4], [10, 4], [-10, 4]].map((p) => rotate(p, 40));
  close(alignedFacing(skewed, 180), 180, 1e-9); // 40° off: keep the given facing
});

test('sigma treats accuracy as a 2D confidence radius', () => {
  close(sigmaFor(20, { ...JUDGE_DEFAULTS, accuracyConfidence: 0.95 }), 20 / 2.4477, 1e-3);
  close(sigmaFor(20, JUDGE_DEFAULTS), 20 / 1.5096, 1e-3);
  close(sigmaFor(1, JUDGE_DEFAULTS), JUDGE_DEFAULTS.minSigma, 0);
});

test('huge accuracy stays cheap', () => {
  assert.ok(samplePoints([0, 0], sigmaFor(1000)).length < 2000);
  assert.equal(judge({ buildings: facingPair, position: [0, -12], accuracy: 1000 }).best, null);
});

test('samples cover the Gaussian densely at palace-scale sigma', () => {
  for (const sigma of [3, 10, 20]) {
    const pts = samplePoints([0, 0], sigma);
    const total = pts.reduce((s, x) => s + x.w, 0);
    assert.ok(total > 0.97 && total < 1, `sigma ${sigma}: ${total}`);
    const farthest = Math.max(...pts.map(({ p }) => Math.hypot(...p)));
    assert.ok(farthest >= 2.5 * sigma, `sigma ${sigma}: reaches ${farthest}`);
    // no point is more than ~one step from its nearest neighbour
    const sample = pts.filter((_, i) => i % 7 === 0);
    for (const { p } of sample) {
      const nn = Math.min(...pts.filter((q) => q.p !== p).map((q) => Math.hypot(q.p[0] - p[0], q.p[1] - p[1])));
      assert.ok(nn <= JUDGE_DEFAULTS.sampleStep + 0.01, `sigma ${sigma}: gap ${nn}`);
    }
  }
});

// A faces south at the origin; B faces north 40 m south of it. Their zones overlap in y ∈ [-25, -15].
const facingPair = withZones([
  { id: 'A', footprint: square(0, 0, 5), facing: [180] },
  { id: 'B', footprint: square(0, -40, 5), facing: [0] },
]);

test('standing in one zone with good GPS picks that building', () => {
  const r = judge({ buildings: facingPair, position: [0, -9], accuracy: 6 });
  assert.equal(r.best, 'A');
  assert.ok(r.ranked[0].p > 0.9, JSON.stringify(r.ranked));
});

test('far from every zone gives no building', () => {
  const r = judge({ buildings: facingPair, position: [200, 200], accuracy: 10 });
  assert.equal(r.best, null);
  assert.deepEqual(r.ranked, []);
});

test('in overlapping zones the nearer footprint wins without heading', () => {
  const r = judge({ buildings: facingPair, position: [0, -18], accuracy: 4 });
  assert.equal(r.best, 'A');
});

test('heading toward the other building flips the answer', () => {
  const r = judge({ buildings: facingPair, position: [0, -18], accuracy: 4, heading: 180 });
  assert.equal(r.best, 'B');
  assert.ok(r.margin > 0.5, JSON.stringify(r.ranked));
});

test('with heading, a building can be shot from outside its zone', () => {
  // In A's zone but turned around toward B, 25 m away and outside B's zone.
  assert.equal(judge({ buildings: facingPair, position: [0, -9], accuracy: 4 }).best, 'A');
  assert.equal(judge({ buildings: facingPair, position: [0, -9], accuracy: 4, heading: 180 }).best, 'B');
});

test('with heading, pointing at nothing checks nothing', () => {
  const lone = withZones([{ id: 'A', footprint: square(0, 0, 5), facing: [180] }]);
  assert.equal(judge({ buildings: lone, position: [0, -12], accuracy: 4, heading: 0 }).best, 'A');
  assert.equal(judge({ buildings: lone, position: [0, -12], accuracy: 4, heading: 180 }).best, null);
  // Typical phone accuracy puts part of the Gaussian inside the footprint; that must not count.
  for (const y of [-10, -8]) {
    const away = judge({ buildings: lone, position: [0, y], accuracy: 10, heading: 180 });
    assert.equal(away.best, null, `y=${y}: ${JSON.stringify(away.ranked)}`);
  }
});

test('poor accuracy spreads probability and shrinks the margin', () => {
  const sharp = judge({ buildings: facingPair, position: [0, -12], accuracy: 4 });
  const blurry = judge({ buildings: facingPair, position: [0, -12], accuracy: 40 });
  assert.ok(blurry.margin < sharp.margin);
  assert.equal(blurry.ranked.length, 2);
});
