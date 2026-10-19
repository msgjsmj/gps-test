import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { centroid } from '../src/geo.js';
import { JUDGE_DEFAULTS, judge } from '../src/judge.js';
import { withZones } from '../src/zones.js';

const area = JSON.parse(readFileSync(new URL('../data/deoksugung.json', import.meta.url)));
const buildings = withZones(area.buildings);

test('area data has unique ids and usable footprints', () => {
  assert.equal(new Set(buildings.map((b) => b.id)).size, buildings.length);
  for (const b of buildings) assert.ok(b.footprint.length >= 3 && b.facing.length >= 1, b.id);
});

for (const accuracy of [5, 10, 20]) {
  test(`every building wins at the middle of its own zones (accuracy ${accuracy} m)`, () => {
    for (const b of buildings) {
      for (const zone of b.zones) {
        const r = judge({ buildings, position: centroid(zone), accuracy });
        assert.equal(r.best, b.id, `${b.name}: ${JSON.stringify(r.ranked)}`);
      }
    }
  });
}

test('default sampling agrees with dense sampling on real data', () => {
  const dense = { ...JUDGE_DEFAULTS, sampleStep: 0.5 };
  const cases = [[[10, -20], 40], [[-4, 20], 15], [[60, -20], 25], [[0, -50], 8]];
  for (const [position, accuracy] of cases) {
    for (const heading of [null, 200]) {
      const fast = judge({ buildings, position, accuracy, heading });
      const ref = judge({ buildings, position, accuracy, heading, params: dense });
      for (const r of ref.ranked) {
        const p = fast.ranked.find((x) => x.id === r.id)?.p ?? 0;
        assert.ok(Math.abs(p - r.p) <= 0.03, `${position} ±${accuracy} h=${heading} ${r.id}: ${p.toFixed(3)} vs ${r.p.toFixed(3)}`);
      }
    }
  }
});
