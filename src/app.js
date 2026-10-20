// Controller: holds state, turns sensor readings into judgments, opens areas, records openings.

import { AREA_DEFAULTS, buildAreas, createDwell, leadingArea } from './areas.js';
import { centroid, dist, normDeg, toGeo, toLocal } from './geo.js';
import { JUDGE_DEFAULTS, PARAMS_VERSION, judge } from './judge.js';
import { STYLE, createMapView } from './map-view.js';
import { requestHeadingPermission, watchHeading, watchPosition } from './sensors.js';
import { exportPayload, isRealPlacement, statsByTest, testContext } from './stats.js';
import { clearAll, loadSetting, loadVisits, requestPersistence, saveSetting, saveVisit } from './store.js';
import { ZONE_DEFAULTS, withZones } from './zones.js';

const $ = (sel) => document.querySelector(sel);

// Readings older than this are treated as missing rather than silently reused.
const MAX_FIX_AGE = 30_000;
const WARN_FIX_AGE = 10_000;
const MAX_HEADING_AGE = 3_000;

const state = {
  area: null,
  areaHash: '',
  buildings: [],
  guide: null, // place descriptions + which place each building opens (data/deoksugung-guide.json)
  areas: [], // what a visitor unlocks: one per place with buildings here
  photos: {}, // place key → { file, author, license, licenseUrl, page }
  placement: null,
  mode: 'sim',
  sim: { point: null, accuracy: 10, heading: 0 },
  gps: { fix: null, error: null, stop: null, centered: false, lastAt: 0, staleBefore: 0, droppedCached: false, watchedAt: 0, lastFixAt: 0 },
  compass: { reading: null, stop: null, denied: false, startedAt: 0 },
  placing: false, // the placement bar is open: map taps move the layout
  visits: [], // records: area openings (and shots from before 2026-10-20), metadata only
};

let quietRender = false; // a refresh whose map changes should not animate
let dwell = createDwell(AREA_DEFAULTS.dwellMs);
// A new test (mode or placement) or a reset starts the wait over, so standing still re-opens nothing stale.
const rearm = () => (dwell = createDwell(AREA_DEFAULTS.dwellMs));

const view = createMapView($('#map'), {
  onMapClick: tapMap,
  // A building or "?": while placing it is just a spot on the map; in simulation it steps into that
  // area; in the field it opens the area's card once the area is open.
  onBuildingClick: (id, point) => tapShape(state.guide.buildingPlace[id], point),
  onAreaClick: (key, point) => tapShape(key, point),
  onLocate() {
    const obs = observe();
    if (obs) return view.panTo(obs.point);
    if (state.mode === 'sim') return toast('먼저 지도를 탭해서 위치를 정하세요');
    const retried = retryGps();
    toast(state.gps.error ?? (retried ? GPS_RETRIED : '아직 위치를 못 잡았어요'));
  },
});

function tapMap(point) {
  if (state.placing) return placeAt(toGeo(state.placement, point));
  if (state.mode !== 'sim') return;
  state.sim.point = point;
  refresh();
}

function tapShape(key, point) {
  if (state.placing || !key) return tapMap(point);
  if (state.mode === 'sim') return stepInto(key);
  if (openedKeys().has(key)) return showCard(key);
  toast('아직 안 가 본 곳이에요 — 가까이 가서 건물 쪽을 바라보면 열려요');
}

// Simulation: the "?" sits on the buildings, where nothing can be aimed at (a spot inside a footprint
// says nothing about where the camera points). Tapping it puts the visitor at the area's first viewing
// spot instead, facing the building.
function stepInto(key) {
  const b = state.buildings.find((x) => x.id === areaOf(key).buildingIds[0]);
  state.sim.point = centroid(b.zones[0]);
  state.sim.heading = Math.round(normDeg(b.facing[0] + 180 + (state.placement.rotationDeg || 0)));
  $('#heading').value = state.sim.heading;
  $('#heading-out').textContent = state.sim.heading;
  refresh();
}

// ---- placement: where the layout sits on the ground ---------------------------

const placementKey = () => `placement:${state.area.id}`;
const realPlacement = () => ({ anchor: { ...state.area.anchor }, rotationDeg: 0 });
const isReal = (p) => isRealPlacement(p, state.area.anchor);
const validPlacement = (p) => Number.isFinite(p?.anchor?.lat) && Number.isFinite(p?.anchor?.lng) && Number.isFinite(p?.rotationDeg);

// The local frame moves with the layout: a simulated point stays at the same spot in the palace.
function setPlacement(next, { save = true } = {}) {
  state.placement = next;
  if (save) saveSetting(placementKey(), next);
  view.setArea(state.area, state.buildings, next, state.areas);
  $('#rotation').value = next.rotationDeg;
  $('#rotation-out').textContent = next.rotationDeg;
  const offKm = dist(toLocal(realPlacement(), next.anchor), [0, 0]) / 1000;
  $('#placement-status').textContent = isReal(next)
    ? `실제 위치 (${state.area.name})`
    : `옮김 · 실제 위치에서 ${offKm.toFixed(1)}km · 회전 ${next.rotationDeg}°`;
  rearm();
  quietRender = true; // redrawn shapes are not openings
  refresh();
  quietRender = false;
}

// Placing happens on the map itself (a bar over it), so the layout stays visible while it moves.
const fitUnderBar = () => view.fit({ top: state.placing ? $('#place-bar').offsetHeight : 0 });

function startPlacing() {
  $('#settings').close();
  state.placing = true;
  document.body.classList.add('placing');
  $('#place-bar').hidden = false;
  view.map.doubleClickZoom.disable(); // every tap places; a double tap must not also zoom
  // First placement in a park: the layout is still kilometres away, so start where the tester is.
  const obs = state.mode === 'gps' && observe();
  if (obs && dist(obs.point, [0, 0]) > 500) view.panTo(obs.point, 17);
  else fitUnderBar();
  refresh();
}

function stopPlacing() {
  if (!state.placing) return;
  state.placing = false;
  document.body.classList.remove('placing');
  $('#place-bar').hidden = true;
  view.map.doubleClickZoom.enable();
  saveSetting(placementKey(), state.placement);
  refresh();
}

// A tapped spot is already in view; only a jump to the GPS position refits the map.
function placeAt({ lat, lng }, { fit = false } = {}) {
  setPlacement({ anchor: { lat, lng }, rotationDeg: state.placement.rotationDeg });
  if (fit) fitUnderBar();
  toast(`${state.area.name} 중심을 옮겼어요 — 다 맞추면 완료`, true);
}

// The placement bar's "내 위치를 중심으로" and the preview's one-tap action both land here.
function placeOnMe() {
  const fix = state.gps.fix;
  if (!fix || Date.now() - fix.receivedAt > MAX_FIX_AGE) return toast(noFixMessage());
  if (fix.accuracy > PLACE_MAX_ACCURACY) {
    view.panTo(toLocal(state.placement, fix), 17);
    return toast(`위치 오차가 커요(±${Math.round(fix.accuracy)}m) — 지도를 내 위치(파란 점)로 옮겼어요. 내가 선 곳을 탭하거나, 오차가 줄면 다시 누르세요`);
  }
  placeAt(fix, { fit: true });
}

// Settings and the preview's action (offered near the real palace) both land here.
function resetPlacement() {
  if (isReal(state.placement)) return toast(`이미 ${state.area.name} 실제 위치예요`);
  if (!confirm(`건물 배치를 ${state.area.name} 실제 위치로 되돌릴까요? 지금 옮긴 배치는 사라져요.`)) return;
  setPlacement(realPlacement());
  view.fit();
  toast(`${state.area.name} 실제 위치로 되돌렸어요`);
}

// ---- observation: what the sensors say right now -------------------------

// Raw world values plus their local-frame form, or null without a usable position.
// heading.value is a TRUE-north bearing (magnetic readings are corrected by the
// area's declination); in simulation it is the settings slider.
function observe() {
  const now = Date.now();
  let fix;
  if (state.mode === 'sim') {
    if (!state.sim.point) return null;
    const g = toGeo(state.placement, state.sim.point);
    fix = { lat: g.lat, lng: g.lng, accuracy: state.sim.accuracy, at: now, receivedAt: now };
  } else {
    fix = state.gps.fix;
    if (!fix || now - fix.receivedAt > MAX_FIX_AGE) return null;
  }
  let heading = null;
  if (state.mode === 'sim') {
    heading = { value: state.sim.heading, accuracy: null, source: 'sim', at: now };
  } else {
    const r = state.compass.reading;
    if (r && now - r.at <= MAX_HEADING_AGE) heading = r;
  }
  return {
    fix,
    heading,
    point: toLocal(state.placement, fix),
    localHeading: heading ? normDeg(heading.value - (state.placement.rotationDeg || 0)) : null,
    at: now,
  };
}

// Both judgments every time, so position-only and position+heading can be compared afterwards;
// the heading one decides whenever there is a heading (no compass → position only).
// The live check reuses results while inputs are unchanged (heading in 2° steps); an opening is
// recorded with an exact judgment.
const cache = { position: { key: '', result: null }, heading: { key: '', result: null } };
function cached(slot, key, compute) {
  if (cache[slot].key !== key) cache[slot] = { key, result: compute() };
  return cache[slot].result;
}

function judgeBoth(obs, { preview = false } = {}) {
  const input = { buildings: state.buildings, position: obs.point, accuracy: obs.fix.accuracy };
  const posKey = `${obs.point.map((v) => v.toFixed(1))}|${obs.fix.accuracy.toFixed(1)}`;
  const position = preview ? cached('position', posKey, () => judge(input)) : judge(input);
  let heading = null;
  if (obs.localHeading !== null) {
    if (preview) {
      const h = Math.round(obs.localHeading / 2) * 2;
      heading = cached('heading', `${posKey}|${h}`, () => judge({ ...input, heading: h }));
    } else {
      heading = judge({ ...input, heading: obs.localHeading });
    }
  }
  const used = heading ? 'heading' : 'position';
  return { position, heading, used, result: used === 'heading' ? heading : position };
}

// ---- rendering ------------------------------------------------------------

const areaOf = (key) => state.areas.find((a) => a.key === key);
// Progress and map colours cover only the current test: same mode and same placement (a
// relocated anchor rounded to ~10 m, so small rotation tweaks don't split it).
const currentTest = () => testContext({ mode: state.mode, placement: state.placement, blind: false }, state.area.anchor);
const inCurrentTest = (v) => testContext(v, state.area.anchor) === currentTest();
const currentOpenings = () => state.visits.filter((v) => v.kind === 'open' && inCurrentTest(v));
const openedKeys = () => new Set(currentOpenings().map((v) => v.placeId));
const secondsAgo = (t) => Math.round((Date.now() - t) / 1000);
// " (N초 전)" once a fix is old enough that the visitor may have moved since (simulated fixes are always fresh).
const ageNote = (fix) => (Date.now() - fix.receivedAt > WARN_FIX_AGE ? ` (${secondsAgo(fix.receivedAt)}초 전)` : '');

// [headline, details, one-tap action?] for the sheet under the map.
function sheetText(obs, current, opened, now) {
  if (!obs) {
    if (state.mode === 'sim') return ['지도를 탭해서 내 위치를 정하세요', ''];
    if (state.gps.fix) return [`위치 신호가 끊겼어요 (${secondsAgo(state.gps.fix.receivedAt)}초 전)`, '하늘이 트인 곳에서 잠시 기다리거나 ◎를 눌러 다시 요청하세요'];
    if (state.gps.error) return [state.gps.error, ''];
    return ['위치를 찾는 중…', ''];
  }
  // Accuracy first: a ±km fix would otherwise read as "you are far from the layout".
  if (obs.fix.accuracy > POOR_ACCURACY) return poorAccuracy(obs);
  const far = farFromLayout(obs);
  if (state.placing) return ['건물 배치를 옮기는 중이에요', '지도를 탭하거나 "내 위치를 중심으로" → 회전으로 맞추고 완료'];
  if (far) return far;
  // Say whether the compass is in play — without it the judgment silently falls back to position.
  const how = state.mode === 'gps' ? (obs.localHeading !== null ? '방향 반영' : '방향 없음 → 위치로 판정') : null;
  const info = [`오차 ±${Math.round(obs.fix.accuracy)}m${ageNote(obs.fix)}`, how].filter(Boolean).join(' · ');
  if (current && opened.has(current)) return [`지금 여기: ${areaOf(current).name}`, info, { label: '설명 보기', run: () => showCard(current) }];
  if (current) return ['? 새로운 곳이에요 — 잠시 그대로 있어 주세요', `${Math.max(1, Math.ceil(dwell.remaining(now) / 1000))}초 뒤 열려요 · ${info}`];
  if (opened.size === state.areas.length) return ['모든 곳을 열었어요 🎉', info];
  return ['물음표(?) 구역으로 가서 건물 쪽을 바라보세요', info];
}

function sensorText(obs) {
  const parts = sensorParts(obs);
  if (unsavedCount()) parts.push(`미저장 ${unsavedCount()}건`);
  return parts.join(' · ');
}

function sensorParts(obs) {
  if (state.mode === 'sim') return [`방향 ${state.sim.heading}°`];
  const parts = [];
  const fix = state.gps.fix;
  if (fix) parts.push(`GPS ±${Math.round(fix.accuracy)}m${ageNote(fix)}`);
  if (state.gps.error && fix) parts.push(state.gps.error);
  if (obs?.heading) {
    const c = obs.heading.correction;
    parts.push(`방향 ${Math.round(obs.heading.value)}°${c ? ` (가로 ${c > 0 ? '+' : ''}${c}°)` : ''}`);
  }
  else if (state.compass.denied) parts.push('방향 권한 거부됨');
  else if (state.compass.stop && state.compass.reading) parts.push('방향 끊김');
  else if (state.compass.stop) parts.push(Date.now() - state.compass.startedAt > 5000 ? '나침반 응답 없음 — 폰을 8자로 움직여 보세요' : '방향 대기 중');
  return parts;
}

let previewAction = null; // what the button under the sheet text does right now

// Judges where the visitor is (not while placing, not with a coarse or far-off fix: it costs up to
// ~30 ms on a laptop, several times that on a phone), lets the leading area wait out its dwell,
// draws, and opens an area whose time is up.
function refresh() {
  const obs = observe();
  const usable = obs && !state.placing && obs.fix.accuracy <= POOR_ACCURACY && !farFromLayout(obs);
  const j = usable ? judgeBoth(obs, { preview: true }) : null;
  const lead = j && leadingArea(j.result, state.guide.buildingPlace);
  const current = lead && lead.p >= AREA_DEFAULTS.minProbability ? lead.key : null;
  const now = Date.now();
  const ready = dwell.update(current, now);
  const opened = openedKeys();
  view.setPosition(obs && { point: obs.point, accuracy: obs.fix.accuracy, heading: obs.localHeading });
  view.render({ opened, current, animateKey: quietRender ? null : currentTest() }); // pulses only within one test
  const [main, sub, action] = sheetText(obs, current, opened, now);
  $('#preview-main').textContent = main;
  $('#preview-sub').textContent = sub;
  previewAction = action?.run ?? null;
  $('#preview-action').hidden = !action;
  if (action) $('#preview-action').textContent = action.label;
  $('#sensor-status').textContent = sensorText(obs);
  $('#progress').textContent = `${opened.size} / ${state.areas.length}`;
  if (ready && !opened.has(ready)) openArea(ready, obs, lead.p);
}

// Sensor events arrive many times a second; redraw at most ~5 times a second.
let refreshQueued = false, lastRefresh = 0;
function scheduleRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  setTimeout(() => {
    refreshQueued = false;
    lastRefresh = performance.now();
    refresh();
  }, Math.max(0, 200 - (performance.now() - lastRefresh)));
}
// The dwell, ages and staleness move on even without sensor events (a still visitor, a simulated point).
setInterval(() => state.area && scheduleRefresh(), 500);

// ---- sensors ----------------------------------------------------------------

const GPS_ERRORS = { 1: '위치 권한이 거부됐어요 — 안내대로 허용한 뒤 새로고침해 주세요', 2: '위치를 확인할 수 없어요', 3: '위치 응답이 늦어요 — 계속 시도 중' };
const POOR_ACCURACY = 50; // meters; beyond this no building can be told apart
const FAR_FROM_LAYOUT = 500; // meters from the layout centre; beyond this nothing opens
const CACHED_FIX_AGE = 120_000; // ms by the fix's own clock; generous for clock skew
const GPS_RETRIED = '위치를 다시 요청했어요 — 잠시 기다려 주세요';
const PLACE_MAX_ACCURACY = 30; // meters; centering the layout on a worse fix misplaces it
const LOCATION_HELP = 'iPhone: 설정 → 개인정보 보호 및 보안 → 위치 서비스 → Safari 웹 사이트 → "앱을 사용하는 동안", "정확한 위치" 켬\nAndroid Chrome: 주소창 왼쪽 아이콘 → 권한 → 위치 허용, 그리고 설정 → 애플리케이션 → Chrome → 권한 → 위치 → "정확한 위치 사용" 켬\n그다음 페이지를 새로고침하세요.';

function startGps() {
  if (state.gps.stop) return;
  if (!window.isSecureContext) {
    state.gps.error = 'HTTPS 주소에서만 위치를 쓸 수 있어요';
    return;
  }
  state.gps.watchedAt = Date.now();
  state.gps.stop = watchPosition(
    (fix) => {
      // After the page was hidden, a fix stamped no later than the last one seen before
      // hiding is a cached pre-lock position (iOS replays it on resume): ignore it.
      if (fix.at <= state.gps.staleBefore) return;
      // A first fix stamped minutes ago is a cached position handed over at start-up. Drop it
      // once only, so a phone with a wrong clock still gets positions after that.
      if (!state.gps.lastAt && !state.gps.droppedCached && Date.now() - fix.at > CACHED_FIX_AGE) {
        state.gps.droppedCached = true;
        state.gps.staleBefore = Math.max(state.gps.staleBefore, fix.at); // a restarted watch may hand it over again
        return;
      }
      state.gps.lastAt = fix.at;
      state.gps.lastFixAt = fix.receivedAt;
      state.gps.fix = fix;
      state.gps.error = null;
      if (!state.gps.centered) {
        state.gps.centered = true;
        const point = toLocal(state.placement, fix);
        if (dist(point, [0, 0]) < 2000) view.panTo(point); // farther: the sheet explains
      }
      scheduleRefresh();
    },
    (err) => {
      state.gps.error = GPS_ERRORS[err.code] ?? err.message;
      if (err.code === 1) {
        // denied: the watch is dead; a later tap on ◎ or a mode switch retries
        state.gps.stop?.();
        state.gps.stop = null;
        notice('위치 권한이 꺼져 있어요', LOCATION_HELP);
      }
      scheduleRefresh();
    },
  );
}

function stopGps() {
  state.gps.stop?.();
  Object.assign(state.gps, { stop: null, fix: null, error: null, centered: false, lastAt: 0, staleBefore: 0, droppedCached: false, watchedAt: 0, lastFixAt: 0 });
}

// A watch can go quiet without any error (e.g. after the page sat in the background). Restart one
// that has delivered nothing for MAX_FIX_AGE. A new watch first hands over the last known position
// with its old timestamp (as on resume), so everything up to the last fix seen counts as stale.
function restartQuietGps() {
  if (!state.gps.stop || Date.now() - Math.max(state.gps.lastFixAt, state.gps.watchedAt) <= MAX_FIX_AGE) return false;
  state.gps.stop();
  state.gps.stop = null;
  state.gps.staleBefore = Math.max(state.gps.staleBefore, state.gps.lastAt);
  state.gps.error = null; // a new attempt: an old "응답이 늦어요" no longer describes it
  startGps();
  return true;
}

// ◎: restart a quiet watch, or start a dead one (after a denial or a failed start). True if it restarted.
function retryGps() {
  const restarted = restartQuietGps();
  startGps();
  return restarted;
}

// Must be called synchronously inside a tap handler (iOS permission prompt).
function startCompass() {
  if (state.compass.stop) return;
  requestHeadingPermission().then((perm) => {
    if (perm !== 'granted') {
      if (!state.compass.denied) notice('방향 권한이 꺼져 있어요', HEADING_HELP);
      state.compass.denied = true;
      return scheduleRefresh();
    }
    state.compass.denied = false;
    state.compass.startedAt ||= Date.now();
    state.compass.stop ??= watchHeading((h) => {
      const declination = state.area.declination ?? 0;
      state.compass.reading = { ...h, magnetic: h.value, value: normDeg(h.value + declination), declination, at: Date.now() };
      scheduleRefresh();
    });
  });
}

function stopCompass() {
  state.compass.stop?.();
  Object.assign(state.compass, { stop: null, reading: null, startedAt: 0 });
}

const HEADING_HELP = '방향 없이도 위치만으로 열려요.\n방향을 쓰려면 페이지를 새로고침하고 "현장에서 시작"에서 허용하세요. 다시 묻지 않으면 Safari를 완전히 닫았다가 다시 열어 주세요.';

// A second notice while one is open is appended, so neither set of instructions is lost.
function notice(title, text) {
  if ($('#notice').open) {
    $('#notice-text').textContent += `\n\n[${title}]\n${text}`;
    return;
  }
  $('#notice-title').textContent = title;
  $('#notice-text').textContent = text;
  $('#notice').showModal();
}

function setMode(mode) {
  state.mode = mode;
  document.body.classList.toggle('mode-gps', mode === 'gps');
  $('#mode-chip').textContent = mode === 'gps' ? '실제 GPS' : '시뮬레이션';
  document.querySelector(`input[name="mode"][value="${mode}"]`).checked = true;
  if (mode === 'gps') {
    startCompass();
    startGps();
  } else {
    stopGps();
    stopCompass();
  }
  rearm();
  quietRender = true; // another test's openings appearing is not an opening
  refresh();
  quietRender = false;
}

// ---- opening an area -------------------------------------------------------

const makeId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const summarize = (r) => r && { best: r.best, ranked: r.ranked, margin: r.margin, sigma: r.sigma };

// FNV-1a of the building data: ties each record to the exact geometry it was judged on.
function hashText(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

// Records the moment an area opens (raw position and heading, both judgments, every parameter —
// enough to re-judge offline later), redraws, and shows its card.
function openArea(key, obs, p) {
  const j = judgeBoth(obs);
  const record = {
    id: makeId(),
    kind: 'open',
    at: new Date(obs.at).toISOString(),
    mode: state.mode,
    fix: { ...obs.fix, ageMs: obs.at - obs.fix.receivedAt },
    heading: obs.heading && { ...obs.heading, ageMs: obs.at - obs.heading.at },
    placement: structuredClone(state.placement),
    area: { id: state.area.id, hash: state.areaHash },
    paramsVersion: PARAMS_VERSION,
    params: structuredClone(JUDGE_DEFAULTS),
    zoneParams: structuredClone(ZONE_DEFAULTS),
    areaParams: structuredClone(AREA_DEFAULTS),
    judgments: { position: summarize(j.position), heading: summarize(j.heading) },
    used: j.used,
    buildingId: j.result.best,
    placeId: key,
    placeP: p, // the area's summed chance in the live judgment that opened it
    blind: false,
  };
  state.visits.push(record);
  persist(record);
  refresh();
  navigator.vibrate?.(80);
  // Never cover what the visitor is reading or doing; the card waits in the records.
  if (document.querySelector('dialog[open]')) return toast(`🔓 ${areaOf(key).name} 열렸어요 — 방문 기록에서 볼 수 있어요`, true);
  showCard(key, { fresh: true });
}

// ---- persistence ---------------------------------------------------------------

// Writes queue here and leave only after a successful save; failures retry on
// the next write or when the page comes back. The count shows in the status line.
const unsaved = new Map(); // record id → snapshot
let flushing = false, flushAgain = false, warnedStorage = false, persistenceAsked = false;
const unsavedCount = () => unsaved.size;

function persist(record) {
  unsaved.set(record.id, { ...record }); // snapshot: a later edit queues a newer one
  flush();
}

let resetGeneration = 0; // a reset stops a flush that is still working through old items

async function flush() {
  if (flushing) return (flushAgain = true);
  flushing = true;
  const generation = resetGeneration;
  if (!persistenceAsked) {
    persistenceAsked = true;
    requestPersistence();
  }
  for (const [id, snap] of [...unsaved]) {
    if (generation !== resetGeneration) break;
    try {
      await saveVisit(snap);
      if (unsaved.get(id) === snap) unsaved.delete(id);
    } catch {}
  }
  flushing = false;
  if (flushAgain) {
    flushAgain = false;
    return flush();
  }
  if (unsavedCount() && !warnedStorage) {
    warnedStorage = true;
    notice('기록 저장에 실패했어요', '다시 시도하는 중이에요. 상태줄의 "미저장 N건"이 0이 될 때까지 기록이 이 화면에만 있어요.\n방문 기록 화면에서 "기록 내보내기"로 꼭 보관하세요.');
  }
  scheduleRefresh();
  if ($('#records').open) renderStats(); // its unsaved warning must not outlive the save
}

const localStamp = (d = new Date()) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
};

// Storage must never block the app: openings recorded before this resolves are merged in. A failed
// load is retried when the page comes back, and export says when stored records are missing.
let visitsLoaded = false;
function loadStoredVisits() {
  const loadedFor = resetGeneration;
  return loadVisits()
    .then((loaded) => {
      if (loadedFor !== resetGeneration) return; // reset while loading: the old records are gone
      const fresh = new Set(state.visits.map((v) => v.id));
      state.visits = [...loaded.filter((v) => !fresh.has(v.id)), ...state.visits];
      visitsLoaded = true;
      quietRender = true; // stored openings appearing at once is not an achievement
      refresh();
      quietRender = false;
    })
    .catch(() => toast('저장된 기록을 불러오지 못했어요 — 다시 시도할게요. 이 브라우저에서는 저장이 안 될 수 있어요'));
}

// Share sheet on phones (AirDrop, Files, messengers); plain download elsewhere.
function exportVisits() {
  if (!visitsLoaded) {
    loadStoredVisits();
    if (!state.visits.length) return toast('저장된 기록을 아직 못 불러왔어요 — 잠시 뒤 다시 눌러 주세요');
    toast('저장된 이전 기록을 못 불러와서 이번 세션 기록만 내보내요');
  }
  if (!state.visits.length) return toast('내보낼 기록이 없어요');
  const payload = exportPayload(state.area, state.visits);
  const file = new File([JSON.stringify(payload, null, 1)], `gps-test-${state.area.id}-${localStamp()}.json`, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    return navigator.share({ files: [file], title: file.name }).catch((e) => {
      if (e.name === 'AbortError') return; // user closed the share sheet
      toast('공유하지 못해 파일로 내려받아요');
      download(file);
    });
  }
  download(file);
}

function download(file) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: file.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

// [headline, how to fix, one-tap action] when the visitor is nowhere near the layout, else null.
// Nothing opens there: it would be judged against a layout kilometres away.
function farFromLayout(obs) {
  const away = dist(obs.point, [0, 0]);
  if (away <= FAR_FROM_LAYOUT) return null;
  const headline = `${isReal(state.placement) ? state.area.name : '옮긴 배치'}에서 ${(away / 1000).toFixed(1)}km 떨어져 있어요`;
  if (state.mode === 'sim') return [headline, '건물 가까이를 탭하세요'];
  // At the real palace with a park layout still set: offer the way back, not another move.
  if (!isReal(state.placement) && dist(toLocal(realPlacement(), obs.fix), [0, 0]) <= FAR_FROM_LAYOUT) {
    return [headline, `지금 ${state.area.name} 근처예요 — 배치를 실제 위치로 되돌리세요`, { label: `${state.area.name} 실제 위치로 되돌리기`, run: resetPlacement }];
  }
  const fix = isReal(state.placement) ? '동네에서 체험하려면 건물 배치를 내 주변으로 옮기세요' : '여기서 체험하려면 배치를 내 주변으로 다시 옮기세요';
  return [headline, fix, { label: '내 주변으로 건물 배치 옮기기', run: moveLayoutHere }];
}

// One tap from "far from the layout" to a usable layout: open the bar and centre it on the visitor.
function moveLayoutHere() {
  startPlacing();
  placeOnMe();
}

function poorAccuracy(obs) {
  return [`위치가 부정확해요 (오차 ±${Math.round(obs.fix.accuracy)}m)`, '하늘이 트인 곳에서 잠시 기다려 주세요. iPhone은 "정확한 위치", Android는 "정확한 위치 사용"이 켜져 있어야 해요'];
}

const noFixMessage = () => (state.mode === 'sim' ? '먼저 지도를 탭해서 위치를 정하세요' : state.gps.error ?? '아직 위치를 못 잡았어요');

// ---- the place card -------------------------------------------------------------

const paragraph = (text) => Object.assign(document.createElement('p'), { textContent: text });

// Photo with its credit, summary, then the full text and footnotes folded away — as on the web guide.
function showCard(key, { fresh = false } = {}) {
  const { place } = areaOf(key);
  const photo = state.photos[key];
  $('#card-figure').hidden = !photo;
  if (photo) {
    $('#card-photo').src = photo.file;
    $('#card-photo').alt = `${place.name} 사진`;
    $('#card-credit').replaceChildren('사진: ', Object.assign(document.createElement('a'), { href: photo.page, target: '_blank', rel: 'noopener', textContent: `${photo.author} · ${photo.license}` }));
  }
  $('#card-fresh').hidden = !fresh;
  $('#card-name').textContent = place.name;
  $('#card-summary').textContent = place.summary;
  $('#card-body').replaceChildren(...place.paragraphs.map(paragraph));
  $('#card-footnotes').replaceChildren(
    ...(place.footnotes ?? []).map((note) => {
      const d = Object.assign(document.createElement('details'), { className: 'footnote' });
      d.append(Object.assign(document.createElement('summary'), { textContent: note.title }), paragraph(note.body));
      return d;
    }),
  );
  $('#card-more').open = false;
  $('#card-more-label').textContent = '더 자세히 읽기';
  if (!$('#card').open) $('#card').showModal();
  $('#card').scrollTop = 0;
}

// ---- toast and records ------------------------------------------------------

let toastTimer;
function toast(text, ok = false) {
  const el = $('#toast');
  // An open modal dialog sits in the top layer above any z-index: show the toast inside it.
  const host = document.querySelector('dialog[open]') ?? document.body;
  if (el.parentElement !== host) host.append(el);
  el.textContent = text;
  el.className = ok ? 'toast ok' : 'toast';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2500);
}

const testLabel = ({ mode, realPlacement, blind }) =>
  `${mode === 'gps' ? '현장 GPS' : '시뮬레이션'} · ${realPlacement ? '실제 위치' : '옮긴 배치'}${blind ? ' · 촬영 테스트(이전 방식)' : ''}`;

function renderStats() {
  const byTest = statsByTest(state.visits, state.area.anchor);
  const current = currentTest();
  const line = (text, strong = false) => Object.assign(document.createElement(strong ? 'strong' : 'p'), { textContent: text });
  const here = { mode: state.mode, realPlacement: isReal(state.placement), blind: false };
  const lines = [line(`이번 체험(${testLabel(here)}) — 열린 곳 ${openedKeys().size} / ${state.areas.length}`, true)];
  // Earlier runs (e.g. the park before the palace, or photo shots from before) stay readable here.
  const others = Object.entries(byTest).filter(([key]) => key !== current);
  if (others.length) lines.push(line('다른 체험', true));
  for (const [, t] of others) {
    const since = new Date(t.firstAt).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    lines.push(line(`${testLabel(t)} (${since}부터) — ${[t.opened.length && `열린 곳 ${t.opened.length}`, t.shots && `촬영 ${t.shots}장`].filter(Boolean).join(' · ')}`));
  }
  if (unsavedCount()) lines.push(line(`⚠︎ 아직 저장되지 않은 항목 ${unsavedCount()}건 — 내보내기로 보관하세요`));
  $('#stats').replaceChildren(...lines);
}

function renderRecords() {
  renderStats();
  const firstOpen = new Map();
  for (const v of currentOpenings()) if (!firstOpen.has(v.placeId)) firstOpen.set(v.placeId, v.at);
  $('#record-list').replaceChildren(
    ...state.areas.map((a) => {
      const at = firstOpen.get(a.key);
      const li = Object.assign(document.createElement('li'), { className: at ? 'done' : 'locked' });
      const mark = Object.assign(document.createElement('span'), { className: 'mark', textContent: at ? '✓' : '?' });
      const time = at && new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const name = Object.assign(document.createElement('button'), { type: 'button', textContent: at ? `${a.name} · ${time}` : '아직 안 가 본 곳', disabled: !at });
      name.addEventListener('click', () => {
        $('#records').close();
        showCard(a.key);
      });
      const thumb = at && state.photos[a.key] ? Object.assign(document.createElement('img'), { src: state.photos[a.key].file, alt: '' }) : document.createElement('span');
      li.append(mark, name, thumb);
      return li;
    }),
  );
}

// ---- wiring -----------------------------------------------------------------

// Legend swatches take the map's own styles, so the help never drifts from what the map draws.
const rgba = (hex, a) => `rgba(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))}, ${a})`;
function paintLegend() {
  for (const el of document.querySelectorAll('[data-swatch]')) {
    const s = Object.assign({}, ...el.dataset.swatch.split('+').map((k) => STYLE[k]));
    el.style.border = `${Math.min(s.weight ?? 3, 4)}px ${s.dashArray ? 'dashed' : 'solid'} ${s.color}`;
    el.style.background = s.fill === false ? 'transparent' : rgba(s.fillColor ?? s.color, s.fillOpacity ?? 0.2); // Leaflet's defaults
  }
}

function bindControls() {
  paintLegend();
  $('#start-gps').addEventListener('click', () => {
    $('#start').hidden = true;
    setMode('gps');
  });
  $('#start-sim').addEventListener('click', () => {
    $('#start').hidden = true;
    setMode('sim');
  });
  for (const id of ['#start-help', '#open-help']) $(id).addEventListener('click', () => $('#help').showModal());
  $('#preview-action').addEventListener('click', () => previewAction?.());
  $('#card-more').addEventListener('toggle', () => ($('#card-more-label').textContent = $('#card-more').open ? '접기' : '더 자세히 읽기'));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.gps.fix) {
      // The visitor may walk while the screen is off; never judge with the pre-lock position.
      state.gps.staleBefore = state.gps.lastAt;
      state.gps.fix = null;
    }
    if (!document.hidden && state.mode === 'gps') restartQuietGps(); // a denied (dead) watch waits for ◎
    if (!document.hidden && unsavedCount()) flush(); // iOS may have dropped the storage connection
    if (!document.hidden && !visitsLoaded) loadStoredVisits();
  });
  $('#open-settings').addEventListener('click', () => {
    stopPlacing();
    $('#settings').showModal();
  });
  $('#progress').addEventListener('click', () => {
    renderRecords();
    $('#records').showModal();
  });
  for (const radio of document.querySelectorAll('input[name="mode"]')) {
    radio.addEventListener('change', (e) => setMode(e.target.value));
  }
  $('#accuracy').addEventListener('input', (e) => {
    state.sim.accuracy = Number(e.target.value);
    $('#accuracy-out').textContent = e.target.value;
    refresh();
  });
  $('#heading').addEventListener('input', (e) => {
    state.sim.heading = Number(e.target.value);
    $('#heading-out').textContent = e.target.value;
    refresh();
  });
  $('#place-start').addEventListener('click', startPlacing);
  $('#place-done').addEventListener('click', stopPlacing);
  $('#place-here').addEventListener('click', placeOnMe);
  // Dragging the slider redraws at most once per frame and saves when released.
  let rotateFrame = 0;
  $('#rotation').addEventListener('input', (e) => {
    state.placement = { ...state.placement, rotationDeg: Number(e.target.value) };
    $('#rotation-out').textContent = e.target.value;
    rotateFrame ||= requestAnimationFrame(() => {
      rotateFrame = 0;
      setPlacement(state.placement, { save: false });
    });
  });
  $('#rotation').addEventListener('change', () => saveSetting(placementKey(), state.placement));
  $('#place-reset').addEventListener('click', resetPlacement);
  $('#export').addEventListener('click', exportVisits);
  $('#reset').addEventListener('click', () => {
    if (!confirm('열린 곳과 기록을 모두 지울까요? 내보내지 않은 기록은 되돌릴 수 없어요.')) return;
    state.visits = [];
    resetGeneration++;
    unsaved.clear();
    clearAll().catch(() => toast('저장된 기록을 지우지 못했어요'));
    rearm();
    refresh();
  });
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json();
}

async function start() {
  bindControls();
  let area, guide;
  try {
    [area, guide] = await Promise.all([fetchJson('data/deoksugung.json'), fetchJson('data/deoksugung-guide.json')]);
  } catch {
    $('#start-note').textContent = '건물 데이터를 불러오지 못했어요. 새로고침해 주세요.';
    $('#start-note').dataset.error = 'true'; // the slow-start watchdog keeps this specific message
    return;
  }
  state.photos = await fetchJson('data/place-photos.json').catch(() => ({})); // cards work without photos
  state.area = area;
  state.areaHash = hashText(JSON.stringify(area.buildings));
  state.buildings = withZones(area.buildings);
  state.guide = guide;
  state.areas = buildAreas(guide.places, guide.buildingPlace, area.buildings);
  for (const el of [$('#title'), $('#start-title')]) el.textContent = `${area.name} 방문 체크`;
  document.title = `${area.name} 방문 체크`;
  loadStoredVisits();
  const saved = loadSetting(placementKey(), null);
  setPlacement(validPlacement(saved) ? saved : realPlacement());
  view.fit();
  for (const b of [$('#start-gps'), $('#start-sim')]) b.disabled = false;
  const note = $('#start-note');
  if (note.dataset.default) note.textContent = note.dataset.default; // the slow-start watchdog fired, but we made it
}

// Any start-up failure (e.g. a cached old page mixed with new code right after a deploy)
// leaves a visible way out instead of a dead start screen.
start().catch((e) => {
  console.error(e);
  // Most often a mix of new and stale cached files right after a deploy: refetch and reload once
  // (index.html's gpsTestSelfHeal). If that already happened, show the error instead.
  if (window.gpsTestSelfHeal?.()) return;
  $('#start-note').textContent = '앱을 시작하지 못했어요. 새로고침해 주세요. 계속되면 잠시 뒤 다시 열어 주세요.';
  $('#start-note').dataset.error = 'true'; // the slow-start watchdog keeps this specific message
});
