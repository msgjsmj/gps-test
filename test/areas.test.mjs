import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildAreas, createDwell, leadingArea } from '../src/areas.js';

const read = (name) => JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url)));
const guide = read('deoksugung-guide.json');
const buildings = read('deoksugung.json').buildings;

test('areas follow the descriptions: shared places group buildings, places without buildings drop out', () => {
  const areas = buildAreas(guide.places, guide.buildingPlace, buildings);
  const byKey = Object.fromEntries(areas.map((a) => [a.key, a.buildingIds]));
  assert.deepEqual(byKey.jeukjodang, ['seogeodang', 'jeukjodang', 'junmyeongdang']);
  assert.deepEqual(byKey.hamnyeongjeon, ['deokhongjeon', 'hamnyeongjeon']);
  assert.deepEqual(byKey.haenggak, ['junghwajeon-haenggak']); // its own description, its own area
  assert.equal(byKey.jungmyeongjeon, undefined); // outside the walls
  assert.equal(areas.length, 9);
  assert.equal(areas.flatMap((a) => a.buildingIds).length, buildings.length);
});

test('an area leads on the sum of its buildings', () => {
  const map = { a1: 'A', a2: 'A', b: 'B' };
  assert.deepEqual(leadingArea({ ranked: [{ id: 'b', p: 0.4 }, { id: 'a1', p: 0.3 }, { id: 'a2', p: 0.3 }] }, map), { key: 'A', p: 0.6 });
  assert.equal(leadingArea({ ranked: [] }, map), null);
  assert.equal(leadingArea(null, map), null);
});

test('an area opens once, after leading without a break for the dwell time', () => {
  const d = createDwell(3000);
  assert.equal(d.update('A', 0), null);
  assert.equal(d.update('A', 2000), null);
  assert.equal(d.remaining(), 1000);
  assert.equal(d.update('A', 3000), 'A');
  assert.equal(d.update('A', 9000), null); // only once while it keeps leading
  assert.equal(d.update(null, 9500), null); // stepped out
  assert.equal(d.update('A', 10_000), null); // back in: the clock starts over
  assert.equal(d.update('B', 11_000), null); // another area takes the lead before A's time is up
  assert.equal(d.update('B', 13_900), null);
  assert.equal(d.update('B', 14_000), 'B');
});

test('aiming runs the clock faster, from the moment it starts', () => {
  const aimed = createDwell(3000);
  assert.equal(aimed.update('A', 0, 2), null);
  assert.equal(aimed.update('A', 1000, 2), null);
  assert.equal(aimed.remaining(), 500);
  assert.equal(aimed.update('A', 1500, 2), 'A'); // 1.5 s instead of 3
  const mixed = createDwell(3000);
  assert.equal(mixed.update('A', 0, 1), null);
  assert.equal(mixed.update('A', 1000, 2), null); // 1 s at normal speed, then aimed
  assert.equal(mixed.update('A', 1900, 2), null);
  assert.equal(mixed.update('A', 2000, 1), 'A'); // 1000 + 2 × 1000 = 3000
});
