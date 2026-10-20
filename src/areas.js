// Areas a visitor unlocks by walking: one per place description that has buildings in the
// layout (e.g. 즉조당 일원 = 즉조당·석어당·준명당). An area's chance in a judgment is the sum
// of its buildings' chances. Position alone says which area the visitor is in; it opens after a
// dwell, which runs faster while the heading agrees (the phone points at that area). Pure functions only.

export const AREA_DEFAULTS = {
  // Position-only judgments spread their weight (samples outside every zone vote for nothing), so
  // the bar is lower than for aimed ones. Field test 2026-10-20 replayed: p ≥ 0.3 opens 32/35 viewing
  // spots, 78% of them right; p ≥ 0.5 opened only 22/35 (77% right).
  minProbability: 0.3,
  dwellMs: 3000, // in an area by position: GPS jitter at its edge must not open it
  aimProbability: 0.5, // the position+heading judgment must lead the same area this clearly to count as aiming
  aimedSpeedup: 2, // aiming runs the dwell this many times faster: 1.5 s
};

// Areas in the guide's order; places with no building here (e.g. 중명전, outside the walls) are left out.
export function buildAreas(places, buildingPlace, buildings) {
  return places
    .map((place) => ({ key: place.key, name: place.name, place, buildingIds: buildings.filter((b) => buildingPlace[b.id] === place.key).map((b) => b.id) }))
    .filter((a) => a.buildingIds.length);
}

// { key, p } of the area with the largest summed chance in a judgment result, or null.
export function leadingArea(result, buildingPlace) {
  const sum = new Map();
  for (const { id, p } of result?.ranked ?? []) {
    const key = buildingPlace[id];
    if (key) sum.set(key, (sum.get(key) ?? 0) + p);
  }
  let best = null;
  for (const [key, p] of sum) if (!best || p > best.p) best = { key, p };
  return best;
}

// update(key, now, rate) returns the key once, when the same key has led without a break for dwellMs
// of clock time; the clock runs at `rate` (as given at the start of each interval). A different key
// (or null) starts over.
export function createDwell(dwellMs) {
  let key = null, last = 0, rate = 1, elapsed = 0, fired = false;
  return {
    update(next, now, nextRate = 1) {
      if (next !== key) [key, elapsed, fired] = [next, 0, false];
      else if (key !== null) elapsed += (now - last) * rate;
      [last, rate] = [now, nextRate];
      if (key === null || fired || elapsed < dwellMs) return null;
      fired = true;
      return key;
    },
    remaining: () => (key === null || fired ? 0 : Math.max(0, (dwellMs - elapsed) / rate)), // wall time at the current rate
  };
}
