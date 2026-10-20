// Records per test. Since 2026-10-20 a record is an area opening (kind 'open', placeId);
// earlier ones are photo shots whose ground truth was tagged in test mode (truth is a
// building id, or 'none' for "no building"). Both stay in storage and exports.

const isOpen = (v) => v.kind === 'open';

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

// A test = same mode + blind or not + same placement. Numbers never mix tests: the
// park run and the palace run, simulation and the field, or a blind accuracy run and
// an open UX run are reported apart. A relocated anchor is rounded to ~10 m so small
// rotation tweaks don't split a test. Only blind tests measure accuracy.
export const isRealPlacement = (placement, areaAnchor) =>
  placement.anchor.lat === areaAnchor.lat && placement.anchor.lng === areaAnchor.lng && !placement.rotationDeg;

export function testContext({ mode, placement, blind }, areaAnchor) {
  const where = isRealPlacement(placement, areaAnchor) ? 'real' : `${placement.anchor.lat.toFixed(4)},${placement.anchor.lng.toFixed(4)}`;
  return `${mode}|${blind ? 'blind' : 'open'}|${where}`;
}

export function statsByTest(visits, areaAnchor) {
  const groups = new Map();
  for (const v of visits) {
    const key = testContext(v, areaAnchor);
    groups.set(key, [...(groups.get(key) ?? []), v]);
  }
  return Object.fromEntries(
    [...groups].map(([key, list]) => {
      const { mode, blind, placement } = list[0];
      const firstAt = list.reduce((min, v) => (v.at < min ? v.at : min), list[0].at); // tells same-named tests apart
      const opened = [...new Set(list.filter(isOpen).map((v) => v.placeId))];
      return [key, { mode, blind: !!blind, realPlacement: isRealPlacement(placement, areaAnchor), firstAt, opened, ...accuracyStats(list.filter((v) => !isOpen(v))) }];
    }),
  );
}

// Records are metadata only, so they export as-is.
export function exportPayload(area, visits, exportedAt = new Date()) {
  return {
    format: 'gps-test-visits/3', // 3: area openings (kind 'open') next to older shots; 2: `blind`, stats by testContext
    exportedAt: exportedAt.toISOString(),
    area: { id: area.id, name: area.name, anchor: area.anchor, declination: area.declination, source: area.source },
    stats: statsByTest(visits, area.anchor), // keyed by testContext(); recompute freely from visits
    visits,
  };
}
