import test from 'node:test';
import assert from 'node:assert/strict';
import { accuracyStats, exportPayload, statsByTest, testContext } from '../src/stats.js';

const anchor = { lat: 37.5, lng: 127 };
const real = { anchor, rotationDeg: 0 };
const park = { anchor: { lat: 37.40001, lng: 127.10001 }, rotationDeg: 30 };

const visit = (truth, positionBest, headingBest, mode = 'gps', placement = real) => ({
  id: Math.random().toString(36),
  at: '2026-10-20T00:00:00.000Z',
  mode,
  placement,
  truth,
  judgments: { position: { best: positionBest }, heading: headingBest === undefined ? null : { best: headingBest } },
  photoBytes: 1234,
});

test('accuracy counts only labeled shots, compares modes on the same shots, and "none" is an answer', () => {
  const s = accuracyStats([
    visit('A', 'A', 'A'),
    visit('B', 'A', 'B'),
    visit('none', null, 'C'),
    visit('A', 'A'), // no heading reading: counts for position only
    visit(undefined, 'A', 'A'), // not labeled
  ]);
  assert.deepEqual(s, {
    shots: 5,
    labeled: 4,
    position: { correct: 3, total: 4 },
    paired: { total: 3, position: 2, heading: 2 },
  });
});

test('a test is mode + placement; rotation tweaks of a relocated layout stay one test', () => {
  assert.equal(testContext('gps', real, anchor), 'gps|real');
  assert.equal(testContext('gps', park, anchor), 'gps|37.4000,127.1000');
  assert.equal(testContext('gps', { ...park, rotationDeg: 35 }, anchor), testContext('gps', park, anchor));
  assert.notEqual(testContext('sim', real, anchor), testContext('gps', real, anchor));
});

test('numbers never mix tests (park vs palace, simulation vs field)', () => {
  const s = statsByTest(
    [visit('A', 'A', 'A'), visit('A', 'B', 'B', 'gps', park), visit('B', 'B', 'B', 'gps', park), visit('A', 'A', 'A', 'sim')],
    anchor,
  );
  assert.deepEqual(Object.keys(s).sort(), ['gps|37.4000,127.1000', 'gps|real', 'sim|real']);
  assert.equal(s['gps|real'].position.correct, 1);
  assert.equal(s['gps|37.4000,127.1000'].shots, 2);
  assert.equal(s['gps|37.4000,127.1000'].position.correct, 1);
});

test('export carries metadata and per-mode stats', () => {
  const area = { id: 'x', name: 'X', anchor, declination: -9, source: 'osm', buildings: [] };
  const p = exportPayload(area, [visit('A', 'A', 'A')], new Date('2026-10-20T01:02:03Z'));
  assert.equal(p.exportedAt, '2026-10-20T01:02:03.000Z');
  assert.equal(p.visits[0].photoBytes, 1234);
  assert.equal(p.area.buildings, undefined);
  assert.equal(p.area.declination, -9);
  assert.equal(p.stats['gps|real'].labeled, 1);
});
