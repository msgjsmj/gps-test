// Areas a visitor unlocks by walking: one per place description that has buildings in the
// layout (e.g. 즉조당 일원 = 즉조당·석어당·준명당). An area's chance in a judgment is the sum
// of its buildings' chances; it opens once it has led long enough. Pure functions only.

export const AREA_DEFAULTS = {
  // Field test 2026-10-20: wrong judgments were confident too (53–97%), so a higher bar mostly
  // drops right answers (p ≥ 0.5: 84% of opened areas right; p ≥ 0.8: 91% but a third fewer opened).
  minProbability: 0.5,
  dwellMs: 2500, // the same area must lead this long: GPS jitter at an area's edge must not open it
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

// update(key, now) returns the key once, when the same key has led for dwellMs without a break;
// a different key (or null) starts over.
export function createDwell(dwellMs) {
  let key = null, since = 0, fired = false;
  return {
    update(next, now) {
      if (next !== key) [key, since, fired] = [next, now, false];
      if (key === null || fired || now - since < dwellMs) return null;
      fired = true;
      return key;
    },
    remaining: (now) => (key === null || fired ? 0 : Math.max(0, dwellMs - (now - since))),
  };
}
