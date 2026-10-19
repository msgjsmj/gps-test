import test from 'node:test';
import assert from 'node:assert/strict';
import { accuracyStats, exportPayload, statsByMode } from '../src/stats.js';

const visit = (truth, positionBest, headingBest, mode = 'gps') => ({
  id: Math.random().toString(36),
  at: '2026-10-20T00:00:00.000Z',
  mode,
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

test('simulated shots are kept out of the field numbers', () => {
  const s = statsByMode([visit('A', 'A', 'A'), visit('A', 'B', 'B', 'sim'), visit('B', 'B', 'B', 'sim')]);
  assert.equal(s.gps.shots, 1);
  assert.equal(s.gps.position.correct, 1);
  assert.equal(s.sim.shots, 2);
  assert.equal(s.sim.position.correct, 1);
});

test('export carries metadata and per-mode stats', () => {
  const area = { id: 'x', name: 'X', anchor: { lat: 1, lng: 2 }, declination: -9, source: 'osm', buildings: [] };
  const p = exportPayload(area, [visit('A', 'A', 'A')], new Date('2026-10-20T01:02:03Z'));
  assert.equal(p.exportedAt, '2026-10-20T01:02:03.000Z');
  assert.equal(p.visits[0].photoBytes, 1234);
  assert.equal(p.area.buildings, undefined);
  assert.equal(p.area.declination, -9);
  assert.equal(p.stats.gps.labeled, 1);
  assert.equal(p.stats.sim.shots, 0);
});
