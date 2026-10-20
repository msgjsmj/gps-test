// Import the place descriptions written for the meorago Deoksugung map site, verbatim.
// Usage: node tools/import-guide.mjs [ref] [out.json]   (default: main, data/deoksugung-guide.json)
// The text is copied as-is (summary, paragraphs, footnotes, sources, review notes and status);
// only buildingPlace — which description each of our buildings opens — is ours.

import { readFileSync, writeFileSync } from 'node:fs';

const REPO = 'puhahasu/meorago-deoksugung-map';
const SITE = 'https://puhahasu.github.io/meorago-deoksugung-map/';

// Our building id → the site's place key. A place may cover several buildings; 중명전
// (jungmyeongjeon) stands outside the palace walls and has no building in our layout.
const BUILDING_PLACE = {
  daehanmun: 'entrance', // assumed: the main gate gets the palace introduction (the site's former "entrance" text)
  gwangmyeongmun: 'gwangmyeongmun',
  junghwamun: 'junghwajeon', // assumed: the gate belongs to the 중화전 precinct (일원)
  junghwajeon: 'junghwajeon',
  seogeodang: 'jeukjodang', // 즉조당 일원 names 즉조당·석어당·준명당
  jeukjodang: 'jeukjodang',
  junmyeongdang: 'jeukjodang',
  deokhongjeon: 'hamnyeongjeon', // 함녕전·덕홍전
  hamnyeongjeon: 'hamnyeongjeon',
  jeonggwanheon: 'jeonggwanheon',
  seokjojeon: 'seokjojeon',
  dondeokjeon: 'dondeokjeon',
  'junghwajeon-haenggak': 'haenggak',
};

async function get(url, as = 'text') {
  const res = await fetch(url, { headers: { 'User-Agent': 'gps-test-prototype/0.1' }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return as === 'json' ? res.json() : res.text();
}

const ref = process.argv[2] ?? 'main';
const out = process.argv[3] ?? 'data/deoksugung-guide.json';

const { sha, commit } = await get(`https://api.github.com/repos/${REPO}/commits/${ref}`, 'json');
const text = await get(`https://raw.githubusercontent.com/${REPO}/${sha}/content.js`);
// The site keeps its data as one JSON array assigned to PLACES; anything else should fail loudly.
const m = text.match(/^\s*const PLACES = (\[[\s\S]*\]);\s*$/);
if (!m) throw new Error('content.js is no longer `const PLACES = [...];` — update this importer');
const places = JSON.parse(m[1]);

for (const p of places) {
  if (!p.key || !p.name || !p.summary || !Array.isArray(p.paragraphs) || !p.paragraphs.length) throw new Error(`incomplete place: ${p.key ?? p.name}`);
}
const keys = new Set(places.map((p) => p.key));
const buildings = JSON.parse(readFileSync('data/deoksugung.json', 'utf8')).buildings.map((b) => b.id);
const unmapped = buildings.filter((id) => !BUILDING_PLACE[id]);
const missing = Object.entries(BUILDING_PLACE).filter(([id, key]) => !buildings.includes(id) || !keys.has(key));
if (unmapped.length || missing.length) throw new Error(`mapping out of date — unmapped: ${unmapped}; unknown: ${missing.map((e) => e.join('→'))}`);

const guide = {
  source: { site: SITE, repo: REPO, file: 'content.js', commit: sha, committedAt: commit.committer.date, importedAt: new Date().toISOString() },
  buildingPlace: BUILDING_PLACE,
  places,
};
writeFileSync(out, `${JSON.stringify(guide, null, 1)}\n`);
const covered = new Set(Object.values(BUILDING_PLACE));
console.log(`${out}: ${places.length} places from ${REPO}@${sha.slice(0, 7)} (${commit.committer.date})`);
console.log(`no building: ${places.filter((p) => !covered.has(p.key)).map((p) => p.name).join(', ') || '-'}`);
