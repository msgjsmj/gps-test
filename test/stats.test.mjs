import test from 'node:test';
import assert from 'node:assert/strict';
import { accuracyStats, exportPayload, statsByTest, testContext } from '../src/stats.js';

const anchor = { lat: 37.5, lng: 127 };
const real = { anchor, rotationDeg: 0 };
const park = { anchor: { lat: 37.40001, lng: 127.10001 }, rotationDeg: 30 };

const visit = (truth, positionBest, headingBest, mode = 'gps', placement = real, blind = true) => ({
  id: Math.random().toString(36),
  at: '2026-10-20T00:00:00.000Z',
  mode,
  placement,
  blind,
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

test('a test is mode + blind + placement; rotation tweaks of a relocated layout stay one test', () => {
  const ctx = (mode, placement, blind = true) => testContext({ mode, placement, blind }, anchor);
  assert.equal(ctx('gps', real), 'gps|blind|real');
  assert.equal(ctx('gps', park), 'gps|blind|37.4000,127.1000');
  assert.equal(ctx('gps', { ...park, rotationDeg: 35 }), ctx('gps', park));
  assert.notEqual(ctx('sim', real), ctx('gps', real));
  assert.notEqual(ctx('gps', real, false), ctx('gps', real, true)); // UX run vs accuracy run
});

test('numbers never mix tests (park vs palace, simulation vs field)', () => {
  const s = statsByTest(
    [visit('A', 'A', 'A'), visit('A', 'B', 'B', 'gps', park), visit('B', 'B', 'B', 'gps', park), visit('A', 'A', 'A', 'sim'), visit('A', 'B', 'B', 'gps', real, false)],
    anchor,
  );
  assert.deepEqual(Object.keys(s).sort(), ['gps|blind|37.4000,127.1000', 'gps|blind|real', 'gps|open|real', 'sim|blind|real']);
  assert.equal(s['gps|blind|real'].position.correct, 1);
  assert.equal(s['gps|blind|37.4000,127.1000'].shots, 2);
  assert.equal(s['gps|blind|37.4000,127.1000'].position.correct, 1);
  assert.equal(s['gps|open|real'].shots, 1);
  assert.equal(s['gps|open|real'].firstAt, '2026-10-20T00:00:00.000Z');
  assert.deepEqual([s['gps|open|real'].blind, s['gps|open|real'].realPlacement], [false, true]);
  assert.deepEqual([s['gps|blind|37.4000,127.1000'].blind, s['gps|blind|37.4000,127.1000'].realPlacement], [true, false]);
});

test('export carries metadata and per-mode stats', () => {
  const area = { id: 'x', name: 'X', anchor, declination: -9, source: 'osm', buildings: [] };
  const p = exportPayload(area, [visit('A', 'A', 'A')], new Date('2026-10-20T01:02:03Z'));
  assert.equal(p.exportedAt, '2026-10-20T01:02:03.000Z');
  assert.equal(p.visits[0].photoBytes, 1234);
  assert.equal(p.area.buildings, undefined);
  assert.equal(p.area.declination, -9);
  assert.equal(p.stats['gps|blind|real'].labeled, 1);
});

test('openings count per test as distinct areas, apart from older photo shots', () => {
  const open = (placeId, placement = real) => ({ id: Math.random().toString(36), at: '2026-10-20T01:00:00.000Z', kind: 'open', mode: 'gps', placement, blind: false, placeId, judgments: { position: { best: 'x' }, heading: null } });
  const s = statsByTest([open('A'), open('B'), open('A'), open('C', park), visit('A', 'A', 'A', 'gps', real, false)], anchor);
  assert.deepEqual(s['gps|open|real'].opened, ['A', 'B']);
  assert.equal(s['gps|open|real'].shots, 1); // the older shot only
  assert.deepEqual(s['gps|open|37.4000,127.1000'].opened, ['C']);
  assert.equal(exportPayload({ id: 'x', name: 'X', anchor }, [open('A')]).format, 'gps-test-visits/3');
});
