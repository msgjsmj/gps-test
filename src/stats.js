// Field-test numbers: how often each judgment mode matched the ground truth
// tagged in test mode. truth is a building id, or 'none' for "no building".

const answer = (judgment) => judgment.best ?? 'none';

// position: over every labeled shot. paired: only shots that also have a
// heading judgment, so position vs heading is compared on the same shots.
export function accuracyStats(visits) {
  const labeled = visits.filter((v) => typeof v.truth === 'string');
  const paired = labeled.filter((v) => v.judgments.heading);
  const correct = (list, mode) => list.filter((v) => answer(v.judgments[mode]) === v.truth).length;
  return {
    shots: visits.length,
    labeled: labeled.length,
    position: { correct: correct(labeled, 'position'), total: labeled.length },
    paired: { total: paired.length, position: correct(paired, 'position'), heading: correct(paired, 'heading') },
  };
}

// Field (real GPS) and simulated shots never mix in the numbers.
export const statsByMode = (visits) => ({
  gps: accuracyStats(visits.filter((v) => v.mode === 'gps')),
  sim: accuracyStats(visits.filter((v) => v.mode === 'sim')),
});

// Visits are metadata only (photos stay on the device), so they export as-is.
export function exportPayload(area, visits, exportedAt = new Date()) {
  return {
    format: 'gps-test-visits/1',
    exportedAt: exportedAt.toISOString(),
    area: { id: area.id, name: area.name, anchor: area.anchor, declination: area.declination, source: area.source },
    stats: statsByMode(visits),
    visits,
  };
}
