// Build an area file from OpenStreetMap: footprints in local meters around an anchor.
// Usage: node tools/build-area.mjs [out.json]   (default data/deoksugung.json)
// Data © OpenStreetMap contributors, ODbL.

import { writeFileSync } from 'node:fs';
import { toLocal } from '../src/geo.js';

const AREA = {
  id: 'deoksugung',
  name: '덕수궁',
  boundaryWay: 26658458,
  anchor: { lat: 37.566134, lng: 126.975054 }, // center of the palace bbox
  // Magnetic declination, degrees east (WMM2025 at the anchor, 2026-10-20: -9.02).
  // Compass readings are magnetic; true bearing = magnetic + declination.
  declination: -9.0,
  // facing: bearings people photograph the building from (180 = its south face).
  // facingAssumed marks values not yet checked on site.
  buildings: [
    { id: 'daehanmun', name: '대한문', osm: 'way/377289797', facing: [90, 270] },
    { id: 'gwangmyeongmun', name: '광명문', osm: 'way/377289803', facing: [180] },
    { id: 'junghwamun', name: '중화문', osm: 'way/181574580', facing: [180] },
    { id: 'junghwajeon', name: '중화전', osm: 'way/181574577', facing: [180] },
    { id: 'seogeodang', name: '석어당', osm: 'way/181574567', facing: [180] },
    { id: 'jeukjodang', name: '즉조당', osm: 'way/181574578', facing: [180] },
    { id: 'junmyeongdang', name: '준명당', osm: 'way/181574572', facing: [180] },
    { id: 'deokhongjeon', name: '덕홍전', osm: 'way/181574569', facing: [180] },
    { id: 'hamnyeongjeon', name: '함녕전', osm: 'way/381755270', facing: [180] },
    { id: 'jeonggwanheon', name: '정관헌', osm: 'way/381755268', facing: [180], facingAssumed: true },
    { id: 'seokjojeon', name: '석조전', osm: 'relation/19357693', facing: [180] },
    { id: 'dondeokjeon', name: '돈덕전', osm: 'way/517072312', facing: [180], facingAssumed: true },
  ],
};

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];

async function overpass(query) {
  const errors = [];
  for (const url of OVERPASS) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'User-Agent': 'gps-test-prototype/0.1', Accept: 'application/json' },
      body: new URLSearchParams({ data: query }),
      signal: AbortSignal.timeout(60_000),
    });
    if (res.ok) return (await res.json()).elements;
    errors.push(`${url} ${res.status}`);
  }
  throw new Error(`Overpass failed: ${errors.join(', ')}`);
}

// Join outer member ways into one ring (members may be split or reversed).
function outerRing(rel) {
  const parts = rel.members.filter((m) => m.role === 'outer').map((m) => m.geometry);
  const ring = [...parts.shift()];
  while (parts.length) {
    const tail = ring.at(-1);
    const same = (a, b) => a.lat === b.lat && a.lon === b.lon;
    const i = parts.findIndex((p) => same(p[0], tail) || same(p.at(-1), tail));
    if (i < 0) throw new Error(`relation ${rel.id}: outer ring does not close`);
    const next = parts.splice(i, 1)[0];
    ring.push(...(same(next[0], tail) ? next : [...next].reverse()).slice(1));
  }
  return ring;
}

function ring(el) {
  const pts = el.type === 'relation' ? outerRing(el) : el.geometry;
  const open = pts.at(0).lat === pts.at(-1).lat && pts.at(0).lon === pts.at(-1).lon ? pts.slice(0, -1) : pts;
  const placement = { anchor: AREA.anchor, rotationDeg: 0 };
  return open.map((p) => toLocal(placement, { lat: p.lat, lng: p.lon }).map((v) => Math.round(v * 10) / 10));
}

const ids = (type) => AREA.buildings.filter((b) => b.osm.startsWith(type)).map((b) => b.osm.split('/')[1]);
const elements = await overpass(
  `[out:json][timeout:60];(way(id:${[AREA.boundaryWay, ...ids('way')].join(',')});relation(id:${ids('relation').join(',')}););out geom;`,
);
const byKey = new Map(elements.map((e) => [`${e.type}/${e.id}`, e]));
const need = (key) => byKey.get(key) ?? (() => { throw new Error(`missing ${key}`); })();

const area = {
  id: AREA.id,
  name: AREA.name,
  source: `© OpenStreetMap contributors (ODbL), fetched ${new Date().toISOString().slice(0, 10)}`,
  declination: AREA.declination,
  anchor: AREA.anchor,
  boundary: ring(need(`way/${AREA.boundaryWay}`)),
  buildings: AREA.buildings.map(({ osm, ...b }) => ({ ...b, osm, footprint: ring(need(osm)) })),
};

const json = JSON.stringify(area, null, 1).replace(/\[\n\s+(-?[\d.]+),\n\s+(-?[\d.]+)\n\s+\]/g, '[$1, $2]');
writeFileSync(process.argv[2] ?? 'data/deoksugung.json', json + '\n'); // written only after a full fetch
