// Which building was photographed? Treat the reported position as a 2D
// Gaussian, sample it deterministically, and let each sample vote.
// P(building) = share of votes.
//
// Position only: a sample votes for the building whose photo zone it stands in
//   (nearest footprint wins where zones overlap).
// With heading: a sample votes for the building the camera points at — inside
//   its zone, or outside it within viewDistance at a discount. If the camera
//   points at nothing, the sample abstains.

import { distToBox, distToPolygon, headingGap, pointInPolygon } from './geo.js';

export const PARAMS_VERSION = 3; // bump whenever defaults change; recorded with each shot

export const JUDGE_DEFAULTS = {
  // Share of fixes inside the reported accuracy radius. Android documents 68%,
  // the W3C spec says 95%; real browsers pass the platform value through.
  accuracyConfidence: 0.68,
  minSigma: 3, // meters; GPS never gets better than this in practice
  sampleStep: 2.5, // meters, max spacing between sample points…
  maxRings: 24, // …until this many rings; coarser beyond, so huge accuracy stays cheap
  touchDistance: 3, // standing this close to a footprint counts as its zone
  proximityScale: 10, // meters; nearer footprints score higher
  minProbability: 0.1, // below this the best guess becomes "no building"
  headingSigma: 30, // degrees; spread of compass error
  viewDistance: 40, // with heading: max footprint distance for out-of-zone shots
  offZoneWeight: 0.5, // with heading: discount for shooting from outside a zone
  minVoteScore: 0.1, // with heading: weaker best scores abstain (pointing at nothing)
};

const MAX_SIGMAS = 2.75;

export function sigmaFor(accuracy, params = JUDGE_DEFAULTS) {
  const radiusInSigmas = Math.sqrt(-2 * Math.log(1 - params.accuracyConfidence)); // 2D Rayleigh quantile
  return Math.max(params.minSigma, accuracy / radiusInSigmas);
}

// Polar grid out to 2.75 sigma, spacing at most `step` (within maxRings);
// weights are the Gaussian mass of each ring split evenly over its points.
export function samplePoints([x, y], sigma, step = JUDGE_DEFAULTS.sampleStep, maxRings = JUDGE_DEFAULTS.maxRings) {
  const dr = Math.max(Math.min(0.5 * sigma, step), (MAX_SIGMAS * sigma) / maxRings);
  const rings = Math.round((MAX_SIGMAS * sigma) / dr);
  const cdf = (r) => 1 - Math.exp(-(r * r) / (2 * sigma * sigma));
  const points = [{ p: [x, y], w: cdf(dr / 2) }];
  for (let k = 1; k <= rings; k++) {
    const n = Math.max(6, Math.ceil(2 * Math.PI * k));
    const w = (cdf((k + 0.5) * dr) - cdf((k - 0.5) * dr)) / n;
    const offset = k % 2 ? 0 : Math.PI / n;
    for (let i = 0; i < n; i++) {
      const a = offset + (2 * Math.PI * i) / n;
      points.push({ p: [x + k * dr * Math.sin(a), y + k * dr * Math.cos(a)], w });
    }
  }
  return points;
}

// buildings: [{ id, footprint, zones, box }] in local meters (see withZones).
// heading: local-frame bearing in degrees, or null for position only.
export function judge({ buildings, position, accuracy, heading = null, params = JUDGE_DEFAULTS }) {
  const sigma = sigmaFor(accuracy, params);
  const reach = MAX_SIGMAS * sigma + params.sampleStep + (heading === null ? params.touchDistance : params.viewDistance);
  const near = buildings.filter((b) => distToBox(position, b.box) <= reach);
  const votes = new Map(near.map((b) => [b.id, 0]));
  let total = 0;

  for (const { p, w } of samplePoints(position, sigma, params.sampleStep, params.maxRings)) {
    total += w;
    let winner = null, best = heading === null ? 0 : params.minVoteScore;
    for (const b of near) {
      const dFoot = distToPolygon(p, b.footprint);
      const inZone = dFoot <= params.touchDistance || b.zones.some((z) => pointInPolygon(p, z));
      let score = 1 / (1 + dFoot / params.proximityScale);
      if (heading === null) {
        if (!inZone) continue;
      } else {
        // A sample inside a footprint says nothing about where the camera points.
        if (dFoot === 0) continue;
        if (!inZone && dFoot > params.viewDistance) continue;
        const gap = headingGap(p, b.footprint, heading);
        score *= (inZone ? 1 : params.offZoneWeight) * Math.exp(-0.5 * (gap / params.headingSigma) ** 2);
      }
      if (score > best) [winner, best] = [b.id, score];
    }
    if (winner) votes.set(winner, votes.get(winner) + w);
  }

  const ranked = [...votes].map(([id, v]) => ({ id, p: v / total })).filter((r) => r.p > 0).sort((a, b) => b.p - a.p);
  const top = ranked[0];
  const best = top && top.p >= params.minProbability ? top.id : null;
  return { best, ranked, sigma, margin: (ranked[0]?.p ?? 0) - (ranked[1]?.p ?? 0) };
}
