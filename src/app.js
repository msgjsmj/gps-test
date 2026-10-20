// Controller: holds state, turns sensor readings into judgments, records visits.

import { cameraLive, cameraSupported, captureFrame, closeCamera, openCamera } from './camera.js';
import { dist, normDeg, toGeo, toLocal } from './geo.js';
import { JUDGE_DEFAULTS, PARAMS_VERSION, judge } from './judge.js';
import { createMapView } from './map-view.js';
import { requestHeadingPermission, watchHeading, watchPosition } from './sensors.js';
import { exportPayload, isRealPlacement, statsByTest, testContext } from './stats.js';
import { clearAll, loadPhoto, loadSetting, loadVisits, requestPersistence, savePhoto, saveSetting, saveVisit } from './store.js';
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
  placement: null,
  mode: 'sim',
  sim: { point: null, accuracy: 10, heading: 0 },
  gps: { fix: null, error: null, stop: null, centered: false, lastAt: 0, staleBefore: 0, droppedCached: false },
  compass: { reading: null, stop: null, denied: false, startedAt: 0 },
  useHeading: false,
  showZones: true,
  placing: false, // the placement bar is open: map taps move the layout
  testMode: false, // ask for the ground truth after every shot
  visits: [], // metadata only; photos go straight to storage
};

let truthTarget = null; // the visit the open truth dialog is about

const view = createMapView($('#map'), {
  onMapClick: tapMap,
  // In simulation (or while placing) a tap on a building is still a map tap; otherwise it focuses the building.
  onBuildingClick: (id, point) => (state.mode === 'sim' || state.placing ? tapMap(point) : view.focus(id)),
  onLocate() {
    if (state.testMode && !state.placing) return toast(BLIND_POSITION); // placing is setup, not a judgment
    const obs = observe();
    if (obs) return view.panTo(obs.point);
    if (state.mode === 'sim') return toast('먼저 지도를 탭해서 위치를 정하세요');
    startGps(); // retries after a denied or failed watch
    toast(state.gps.error ?? '아직 위치를 못 잡았어요');
  },
});

function tapMap(point) {
  if (state.placing) return placeAt(toGeo(state.placement, point));
  if (state.mode !== 'sim') return;
  state.sim.point = point;
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
  view.setArea(state.area, state.buildings, next);
  $('#rotation').value = next.rotationDeg;
  $('#rotation-out').textContent = next.rotationDeg;
  const offKm = dist(toLocal(realPlacement(), next.anchor), [0, 0]) / 1000;
  $('#placement-status').textContent = isReal(next)
    ? `실제 위치 (${state.area.name})`
    : `옮김 · 실제 위치에서 ${offKm.toFixed(1)}km · 회전 ${next.rotationDeg}°`;
  refresh();
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
  refresh(); // shows the own-position dot even in blind test mode while placing
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

// ---- observation: what the sensors say right now -------------------------

// Raw world values plus their local-frame form, or null without a usable position.
// heading.value is a TRUE-north bearing (magnetic readings are corrected by the
// area's declination); in simulation the slider only counts while "use heading" is on.
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
    if (state.useHeading) heading = { value: state.sim.heading, accuracy: null, source: 'sim', at: now };
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

// Both judgments every time, so heading on/off can be compared afterwards.
// The live preview reuses results while inputs are unchanged (heading in 2° steps);
// a shot is always judged exactly.
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
  const used = state.useHeading && heading ? 'heading' : 'position';
  return { position, heading, used, result: used === 'heading' ? heading : position };
}

// ---- rendering ------------------------------------------------------------

const nameOf = (id) => state.buildings.find((b) => b.id === id)?.name ?? id;
// Progress, map colours and accuracy cover only the current test: same mode and same
// placement (a relocated anchor rounded to ~10 m, so small rotation tweaks don't split it).
const currentTest = () => testContext({ mode: state.mode, placement: state.placement, blind: state.testMode }, state.area.anchor);
const inCurrentTest = (v) => testContext(v, state.area.anchor) === currentTest();
const currentVisits = () => state.visits.filter(inCurrentTest);
// A shot whose truth dialog is still open stays out, so blind test mode leaks nothing behind the dialog.
// What a shot "completes": the judged building, except in blind tests, where it is the building
// the tester says they actually shot — so a misjudged neighbour never looks done.
const doneBuilding = (v) => (v.blind ? (v.truth && v.truth !== 'none' ? v.truth : null) : v.buildingId);
const visitedIds = () => new Set(currentVisits().filter((v) => v !== truthTarget).map(doneBuilding).filter(Boolean));
const pct = (p) => `${Math.round(p * 100)}%`;
const secondsAgo = (t) => Math.round((Date.now() - t) / 1000);

function previewText(obs, j) {
  if (!obs) {
    if (state.mode === 'sim') return ['지도를 탭해서 내 위치를 정하세요', ''];
    if (state.gps.fix) return [`위치 신호가 끊겼어요 (${secondsAgo(state.gps.fix.receivedAt)}초 전)`, '하늘이 트인 곳에서 잠시 기다려 주세요'];
    if (state.gps.error) return [state.gps.error, ''];
    return ['위치를 찾는 중…', ''];
  }
  const acc = `오차 ±${Math.round(obs.fix.accuracy)}m`;
  // With "use heading" on, say whether it is actually in play — a missing compass silently means position only.
  const how = state.useHeading ? (j.used === 'heading' ? '방향 반영' : '방향 없음 → 위치로 판정') : null;
  // Accuracy first: a ±km fix would otherwise read as "you are far from the layout".
  if (obs.fix.accuracy > POOR_ACCURACY) return [`위치가 부정확해요 (${acc})`, '하늘이 트인 곳에서 잠시 기다려 주세요. iPhone은 "정확한 위치"가 켜져 있어야 해요'];
  const away = dist(obs.point, [0, 0]);
  if (away > 500) {
    const fix = isReal(state.placement)
      ? '동네에서 테스트하려면 ⚙︎ 설정 → 배치 옮기기·회전'
      : '실제 궁이면 ⚙︎ 설정 → 실제 위치로 되돌리기 · 동네면 ⚙︎ 설정 → 배치 옮기기·회전';
    return [`${isReal(state.placement) ? state.area.name : '옮긴 배치'}에서 ${(away / 1000).toFixed(1)}km 떨어져 있어요`, fix];
  }
  // Test mode is blind: showing the would-be answer would let the tester walk until it agrees.
  if (state.testMode) return ['촬영 준비됨 · 테스트 모드', [acc, how].filter(Boolean).join(' · ')];
  const { result } = j;
  if (!result.best) return ['근처에 촬영 대상 건물이 없어요', [acc, how].filter(Boolean).join(' · ')];
  const others = result.ranked.slice(1, 3).map((r) => `${nameOf(r.id)} ${pct(r.p)}`);
  return [`지금 찍으면 → ${nameOf(result.best)} (${pct(result.ranked[0].p)})`, [...others, acc, how].filter(Boolean).join(' · ')];
}

function sensorText(obs) {
  const parts = sensorParts(obs);
  if (unsavedCount()) parts.push(`미저장 ${unsavedCount()}건`);
  return parts.join(' · ');
}

function sensorParts(obs) {
  if (state.mode === 'sim') return state.useHeading ? [`방향 ${state.sim.heading}°`] : [];
  const parts = [];
  const fix = state.gps.fix;
  if (fix) parts.push(`GPS ±${Math.round(fix.accuracy)}m${Date.now() - fix.receivedAt > WARN_FIX_AGE ? ` (${secondsAgo(fix.receivedAt)}초 전)` : ''}`);
  if (state.gps.error && fix) parts.push(state.gps.error);
  if (obs?.heading) parts.push(`방향 ${Math.round(obs.heading.value)}°`);
  else if (state.compass.denied) parts.push('방향 권한 거부됨');
  else if (state.compass.stop && state.compass.reading) parts.push('방향 끊김');
  else if (state.compass.stop) parts.push(Date.now() - state.compass.startedAt > 5000 ? '나침반 응답 없음 — 폰을 8자로 움직여 보세요' : '방향 대기 중');
  return parts;
}

function refresh() {
  const obs = observe();
  const j = obs && judgeBoth(obs, { preview: true });
  // Blind test mode hides the own-position dot too: standing where the dot sits inside a zone
  // would make position-only accuracy circular (the judgment uses that same dot).
  view.setPosition((!state.testMode || state.placing) && obs && { point: obs.point, accuracy: obs.fix.accuracy, heading: obs.localHeading });
  view.render({ visited: visitedIds(), candidateId: state.testMode ? null : j?.result.best, showZones: state.showZones });
  const [main, sub] = previewText(obs, j);
  $('#preview-main').textContent = main;
  $('#preview-sub').textContent = sub;
  $('#sensor-status').textContent = sensorText(obs);
  $('#camera-preview').textContent = sub ? `${main} · ${sub}` : main;
  $('#progress').textContent = `${visitedIds().size} / ${state.buildings.length}`;
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
setInterval(() => state.mode === 'gps' && scheduleRefresh(), 1000); // ages and staleness tick even without events

// ---- sensors ----------------------------------------------------------------

const GPS_ERRORS = { 1: '위치 권한이 거부됐어요 — 안내대로 허용한 뒤 새로고침해 주세요', 2: '위치를 확인할 수 없어요', 3: '위치 응답이 늦어요 — 계속 시도 중' };
const POOR_ACCURACY = 50; // meters; beyond this no building can be told apart
const CACHED_FIX_AGE = 120_000; // ms by the fix's own clock; generous for clock skew
const BLIND_POSITION = '테스트 모드에서는 내 위치를 숨겨요 — 지도 바탕(길·나무·시설)을 보고 서 주세요';
const PLACE_MAX_ACCURACY = 30; // meters; centering the layout on a worse fix misplaces it
const LOCATION_HELP = 'iPhone: 설정 → 개인정보 보호 및 보안 → 위치 서비스 → Safari 웹 사이트 → "앱을 사용하는 동안", "정확한 위치" 켬\nAndroid Chrome: 주소창 왼쪽 아이콘 → 권한 → 위치 허용\n그다음 페이지를 새로고침하세요.';

function startGps() {
  if (state.gps.stop) return;
  if (!window.isSecureContext) {
    state.gps.error = 'HTTPS 주소에서만 위치를 쓸 수 있어요';
    return;
  }
  state.gps.stop = watchPosition(
    (fix) => {
      // After the page was hidden, a fix stamped no later than the last one seen before
      // hiding is a cached pre-lock position (iOS replays it on resume): ignore it.
      if (fix.at <= state.gps.staleBefore) return;
      // A first fix stamped minutes ago is a cached position handed over at start-up. Drop it
      // once only, so a phone with a wrong clock still gets positions after that.
      if (!state.gps.lastAt && !state.gps.droppedCached && Date.now() - fix.at > CACHED_FIX_AGE) {
        state.gps.droppedCached = true;
        return;
      }
      state.gps.lastAt = fix.at;
      state.gps.fix = fix;
      state.gps.error = null;
      if (!state.gps.centered) {
        state.gps.centered = true;
        const point = toLocal(state.placement, fix);
        const far = dist(point, [0, 0]);
        if (far < 2000 && !state.testMode) view.panTo(point); // farther: the preview explains; blind: don't reveal
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
  Object.assign(state.gps, { stop: null, fix: null, error: null, centered: false, lastAt: 0, staleBefore: 0, droppedCached: false });
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

const HEADING_HELP = '방향 없이도 위치만으로 판정돼요.\n방향을 쓰려면 페이지를 새로고침하고 "현장에서 시작"에서 허용하세요. 다시 묻지 않으면 Safari를 완전히 닫았다가 다시 열어 주세요.';
const CAMERA_HELP = '카메라 없이 찍은 기록은 남기지 않아요.\nSafari: 주소창의 "가가(aA)" → 웹 사이트 설정 → 카메라 → 허용\nChrome: 주소창 왼쪽 아이콘 → 권한 → 카메라 허용\n그다음 페이지를 새로고침하세요.';

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
  refresh();
}

// ---- shooting ---------------------------------------------------------------

const makeId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// Stand-in photo when no camera is available (desktop, denied permission).
function simulatedPhoto(obs) {
  const c = document.createElement('canvas');
  c.width = 480;
  c.height = 360;
  const g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, 360);
  sky.addColorStop(0, '#90cdf4');
  sky.addColorStop(1, '#fefcbf');
  g.fillStyle = sky;
  g.fillRect(0, 0, 480, 360);
  g.fillStyle = '#7b341e';
  g.beginPath();
  g.moveTo(60, 200);
  g.quadraticCurveTo(240, 120, 420, 200);
  g.fill();
  g.fillRect(110, 200, 260, 110);
  g.fillStyle = '#1a202c';
  g.font = 'bold 22px sans-serif';
  g.fillText('SIMULATED', 16, 34);
  g.font = '16px sans-serif';
  g.fillText(`${new Date().toLocaleTimeString()}  ${obs.fix.lat.toFixed(6)}, ${obs.fix.lng.toFixed(6)}`, 16, 345);
  return new Promise((resolve) =>
    c.toBlob((blob) => {
      c.width = c.height = 0; // release canvas memory (iOS caps the total)
      resolve(blob);
    }, 'image/jpeg', 0.8),
  );
}

const summarize = (r) => r && { best: r.best, ranked: r.ranked, margin: r.margin, sigma: r.sigma };

// FNV-1a of the building data: ties each shot to the exact geometry it was judged on.
function hashText(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

// obs and judgments are taken at the shutter moment; the photo may resolve later.
async function record(obs, j, photoPromise, photoKind) {
  const visit = {
    id: makeId(),
    at: new Date(obs.at).toISOString(),
    mode: state.mode,
    fix: { ...obs.fix, ageMs: obs.at - obs.fix.receivedAt },
    heading: obs.heading && { ...obs.heading, ageMs: obs.at - obs.heading.at },
    placement: structuredClone(state.placement),
    area: { id: state.area.id, hash: state.areaHash },
    paramsVersion: PARAMS_VERSION,
    params: structuredClone(JUDGE_DEFAULTS),
    zoneParams: structuredClone(ZONE_DEFAULTS),
    judgments: { position: summarize(j.position), heading: summarize(j.heading) },
    used: j.used,
    buildingId: j.result.best,
    photoKind,
    blind: state.testMode, // judgment hidden while aiming: only these shots measure accuracy
  };
  const photo = await photoPromise.catch(() => null);
  visit.photoBytes = photo?.size ?? 0;
  state.visits.push(visit);
  persist(visit);
  persistPhoto(visit.id, photo);
  if (state.testMode) return askTruth(visit); // the result shows after the truth is tagged
  refresh();
  if (visit.buildingId) toast(`✓ ${nameOf(visit.buildingId)} 방문 체크!`, true);
  else toast('근처에 촬영 대상 건물이 없어서 체크하지 않았어요');
}

// ---- persistence and ground truth -------------------------------------------

// Writes queue here and leave only after a successful save; failures retry on
// the next write or when the page comes back. The count shows in the status line.
const unsaved = new Map(); // visit id → metadata snapshot
const unsavedPhotos = new Map(); // visit id → photo blob (held in memory only until saved)
let flushing = false, flushAgain = false, warnedStorage = false, persistenceAsked = false;
const unsavedCount = () => unsaved.size + unsavedPhotos.size;

function persist(visit) {
  unsaved.set(visit.id, { ...visit }); // snapshot: a later edit queues a newer one
  flush();
}

function persistPhoto(id, blob) {
  if (!blob) return;
  unsavedPhotos.set(id, blob);
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
  for (const [id, blob] of [...unsavedPhotos]) {
    if (generation !== resetGeneration) break;
    try {
      await savePhoto(id, blob);
      if (unsavedPhotos.get(id) === blob) unsavedPhotos.delete(id);
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

const choiceButton = (label, className, onClick) => {
  const b = Object.assign(document.createElement('button'), { type: 'button', textContent: label, className });
  b.addEventListener('click', onClick);
  return b;
};

// The photo itself is the tester's memory aid when tagging later from the log.
let truthPhotoUrl = null;
async function showTruthPhoto(visit) {
  const img = $('#truth-photo');
  img.hidden = true;
  if (!visit.photoBytes) return;
  const blob = unsavedPhotos.get(visit.id) ?? (await loadPhoto(visit.id).catch(() => null));
  if (!blob || truthTarget !== visit) return; // dialog moved on meanwhile
  if (truthPhotoUrl) URL.revokeObjectURL(truthPhotoUrl);
  truthPhotoUrl = URL.createObjectURL(blob);
  img.src = truthPhotoUrl;
  img.hidden = false;
}

// Nearby candidates (from either judgment) first, in data order, then every other building.
// The judgment itself stays hidden until a choice is made, so it cannot steer the answer.
function askTruth(visit) {
  truthTarget = visit;
  const order = state.buildings.map((b) => b.id);
  // Blind shots list every building in fixed order with nothing marked: highlighting the
  // nearby candidates would often single out exactly the judged building.
  const ranked = visit.blind ? new Set() : new Set([visit.judgments.position, visit.judgments.heading].filter(Boolean).flatMap((j) => j.ranked.map((r) => r.id)));
  const candidates = order.filter((id) => ranked.has(id));
  const rest = order.filter((id) => !ranked.has(id));
  const time = new Date(visit.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  $('#truth-judged').textContent = `${time} 촬영 · ${visit.truth ? `기록된 정답: ${truthName(visit.truth)}` : '판정 결과는 고른 뒤에 보여드려요'}`;
  showTruthPhoto(visit);
  $('#truth-choices').replaceChildren(
    ...[...candidates, ...rest].map((id) => choiceButton(nameOf(id), candidates.includes(id) ? 'candidate' : '', () => setTruth(visit, id))),
    choiceButton('건물 아님', 'none', () => setTruth(visit, 'none')),
  );
  $('#truth').showModal();
}

const truthName = (truth) => (truth === 'none' ? '건물 아님' : nameOf(truth));

function setTruth(visit, truth) {
  truthTarget = null;
  visit.truth = truth;
  visit.truthAt = new Date().toISOString();
  refresh(); // progress and colours count the truth right away
  $('#truth').close();
  persist(visit);
  const right = (visit.buildingId ?? 'none') === truth;
  const judged = visit.buildingId ? nameOf(visit.buildingId) : '건물 없음';
  toast(right ? `정답 ${truthName(truth)} — 판정 맞음` : `정답 ${truthName(truth)} — 판정은 ${judged}(틀림)`, right);
  if ($('#records').open) renderRecords();
}

const localStamp = (d = new Date()) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
};

// Share sheet on phones (AirDrop, Files, messengers); plain download elsewhere.
function exportVisits() {
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

const noFixMessage = () => (state.mode === 'sim' ? '먼저 지도를 탭해서 위치를 정하세요' : state.gps.error ?? '아직 위치를 못 잡았어요');

function shootSimulated() {
  const obs = observe();
  if (!obs) return toast(noFixMessage());
  record(obs, judgeBoth(obs), simulatedPhoto(obs), 'simulated');
}

async function openShutter() {
  if (!$('#camera').hidden) return; // already open or opening
  stopPlacing(); // a stray tap while shooting must not move the layout
  if (state.mode === 'gps') startCompass(); // retry the iOS prompt inside this tap if needed
  if (!cameraSupported()) return shootSimulated();
  const video = $('#camera-video');
  $('#camera-shutter').disabled = true; // enabled once frames flow
  $('#camera').hidden = false;
  try {
    await openCamera(video, () => {
      closeShutter();
      toast('카메라 연결이 끊겼어요');
    });
    $('#camera-shutter').disabled = false;
  } catch (e) {
    if (e.name === 'CameraCancelled') return; // closed while opening
    closeShutter();
    // A denied camera must not silently turn shots into un-aimed records.
    if (e.name === 'NotAllowedError' || e.name === 'SecurityError') return notice('카메라 권한이 꺼져 있어요', CAMERA_HELP);
    if (['NotFoundError', 'OverconstrainedError', 'NotSupportedError'].includes(e.name)) return shootSimulated(); // no camera here (desktop, headless)
    if (e.name === 'CameraPlayFailed') return toast('카메라 화면을 시작하지 못했어요 — 다시 눌러 주세요');
    toast('카메라를 열 수 없어요 — 다른 앱이 카메라를 쓰고 있지 않은지 확인해 주세요');
  }
}

function closeShutter() {
  closeCamera($('#camera-video'));
  $('#camera').hidden = true;
}

function shutter() {
  const video = $('#camera-video');
  const button = $('#camera-shutter');
  if (button.disabled || !cameraLive(video)) return;
  const obs = observe();
  if (!obs) return toast(noFixMessage());
  const photo = captureFrame(video); // grab the frame first, then judge
  button.disabled = true;
  const j = judgeBoth(obs);
  photo.then(closeShutter, closeShutter);
  record(obs, j, photo, 'camera');
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

const ratio = (a, b) => (b ? `${a}/${b} (${Math.round((100 * a) / b)}%)` : '-');

const testLabel = ({ mode, realPlacement, blind }) =>
  `${mode === 'gps' ? '현장 GPS' : '시뮬레이션'} · ${realPlacement ? '실제 위치' : '옮긴 배치'} · ${blind ? '테스트 모드' : 'UX 확인'}`;

const EMPTY_STATS = { shots: 0, labeled: 0, position: { correct: 0, total: 0 }, paired: { total: 0, position: 0, heading: 0 } };

function renderStats() {
  const byTest = statsByTest(state.visits, state.area.anchor);
  const current = currentTest();
  const s = byTest[current] ?? EMPTY_STATS;
  const line = (text, strong = false) => Object.assign(document.createElement(strong ? 'strong' : 'p'), { textContent: text });
  const here = { mode: state.mode, realPlacement: isReal(state.placement), blind: state.testMode };
  const lines = [line(`이번 테스트(${testLabel(here)}) 촬영 ${s.shots}장`, true)];
  if (!state.testMode) {
    // Open shots saw the would-be answer while aiming, so they never count as accuracy data.
    lines.push(line('정답률은 테스트 모드(판정을 숨긴 상태)에서 찍은 사진만 세요. 지금은 UX 확인용이에요.'));
  } else {
    lines.push(line(`정답 기록 ${s.labeled}장${s.labeled ? ` · 위치만 판정 정답 ${ratio(s.position.correct, s.position.total)}` : ''}`));
    if (s.paired.total) lines.push(line(`방향 있는 ${s.paired.total}장 비교: 위치만 ${ratio(s.paired.position, s.paired.total)} · 위치+방향 ${ratio(s.paired.heading, s.paired.total)}`));
    if (!s.labeled && s.shots) lines.push(line('촬영 후 "실제로 찍은 건물은?"에 답하거나, 아래 로그를 탭해 기록하면 정답률이 나와요.'));
  }
  // Earlier tests (e.g. the park run after resetting to the palace) stay readable here.
  const others = Object.entries(byTest).filter(([key]) => key !== current);
  if (others.length) lines.push(line('다른 테스트', true));
  for (const [, t] of others) {
    const accuracy = t.blind
      ? ` · 정답 기록 ${t.labeled}장${t.labeled ? ` · 위치만 ${ratio(t.position.correct, t.position.total)}` : ''}${t.paired.total ? ` · 방향 있는 ${t.paired.total}장: 위치+방향 ${ratio(t.paired.heading, t.paired.total)}` : ''}`
      : '';
    const since = new Date(t.firstAt).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    lines.push(line(`${testLabel(t)} (${since}부터) — 촬영 ${t.shots}장${accuracy}`));
  }
  if (unsavedCount()) lines.push(line(`⚠︎ 아직 저장되지 않은 항목 ${unsavedCount()}건 — 내보내기로 보관하세요`));
  $('#stats').replaceChildren(...lines);
}

function renderShotLog() {
  $('#shot-log').replaceChildren(
    ...[...state.visits].reverse().map((v) => { // toReversed() needs Safari 16
      const r = v.judgments[v.used];
      // An untagged blind shot keeps its judgment hidden, or tagging it later would just copy the judgment.
      const judged = v.blind && !v.truth ? '판정 숨김' : v.buildingId ? `${nameOf(v.buildingId)} ${pct(r.ranked[0].p)}` : '건물 없음';
      const time = new Date(v.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const b = choiceButton('', '', () => askTruth(v));
      const tag = inCurrentTest(v) ? '' : `[다른 테스트${v.mode === 'sim' ? '·시뮬' : ''}] `;
      b.append(`${time} · ${tag}${judged} · ±${Math.round(v.fix.accuracy)}m${v.used === 'heading' ? ' · 방향' : ''} · `);
      const right = v.truth && (v.buildingId ?? 'none') === v.truth;
      b.append(v.truth ? Object.assign(document.createElement('span'), { className: right ? 'ok' : 'ng', textContent: `정답 ${truthName(v.truth)} ${right ? '✓' : '✗'}` }) : '정답 미기록');
      const li = document.createElement('li');
      li.append(b);
      return li;
    }),
  );
}

// Thumbnails are read from storage (or the unsaved queue) only while the records dialog is open.
let thumbUrls = [];
async function showThumb(slot, id, alt) {
  const blob = unsavedPhotos.get(id) ?? (await loadPhoto(id).catch(() => null));
  if (!blob || !$('#records').open) return;
  const url = URL.createObjectURL(blob);
  thumbUrls.push(url);
  slot.replaceWith(Object.assign(document.createElement('img'), { src: url, alt }));
}

function renderRecords() {
  renderStats();
  renderShotLog();
  $('#record-list').replaceChildren(
    ...state.buildings.map((b) => {
      const mine = currentVisits().filter((v) => doneBuilding(v) === b.id);
      const li = document.createElement('li');
      li.className = mine.length ? 'done' : '';
      const mark = Object.assign(document.createElement('span'), { className: 'mark', textContent: mine.length ? '✓' : '○' });
      const name = Object.assign(document.createElement('button'), { type: 'button', textContent: mine.length > 1 ? `${b.name} (${mine.length}장)` : b.name });
      name.addEventListener('click', () => {
        $('#records').close();
        view.focus(b.id);
      });
      const thumb = document.createElement('span');
      const last = mine.findLast((v) => v.photoBytes);
      if (last) showThumb(thumb, last.id, `${b.name} 사진`);
      li.append(mark, name, thumb);
      return li;
    }),
  );
}

// ---- wiring -----------------------------------------------------------------

function bindControls() {
  $('#start-gps').addEventListener('click', () => {
    $('#start').hidden = true;
    setMode('gps');
  });
  $('#start-sim').addEventListener('click', () => {
    $('#start').hidden = true;
    setMode('sim');
  });
  $('#shoot').addEventListener('click', openShutter);
  $('#camera-shutter').addEventListener('click', shutter);
  $('#camera-close').addEventListener('click', closeShutter);
  // A backgrounded page must not keep the camera (Android keeps capturing; iOS returns a muted track).
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && !$('#camera').hidden) closeShutter();
    if (document.hidden && state.gps.fix) {
      // The tester may walk while the screen is off; never judge with the pre-lock position.
      state.gps.staleBefore = state.gps.lastAt;
      state.gps.fix = null;
    }
    if (!document.hidden && unsavedCount()) flush(); // iOS may have dropped the storage connection
  });
  $('#open-settings').addEventListener('click', () => {
    stopPlacing();
    $('#settings').showModal();
  });
  $('#progress').addEventListener('click', () => {
    renderRecords();
    $('#records').showModal();
  });
  $('#truth').addEventListener('close', () => {
    if (truthPhotoUrl) URL.revokeObjectURL(truthPhotoUrl);
    truthPhotoUrl = null;
    $('#truth-photo').hidden = true;
    // Skipped (button or Esc). A blind shot keeps its judgment hidden, or a label added
    // later from the log would be anchored on it; an open shot showed it while aiming anyway.
    if (!truthTarget) return;
    const v = truthTarget;
    truthTarget = null;
    refresh();
    if (v.truth) return toast(`정답은 그대로예요: ${truthName(v.truth)}`);
    if (v.blind) return toast('정답 미기록 — 방문 기록 화면의 로그에서 나중에 기록할 수 있어요');
    toast(`정답 미기록 — 판정은 ${v.buildingId ? nameOf(v.buildingId) : '건물 없음'}`);
  });
  $('#records').addEventListener('close', () => {
    thumbUrls.forEach((u) => URL.revokeObjectURL(u));
    thumbUrls = [];
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
  $('#use-heading').addEventListener('change', (e) => {
    state.useHeading = e.target.checked;
    refresh();
  });
  $('#show-zones').addEventListener('change', (e) => {
    state.showZones = e.target.checked;
    refresh();
  });
  $('#place-start').addEventListener('click', startPlacing);
  $('#place-done').addEventListener('click', stopPlacing);
  $('#place-here').addEventListener('click', () => {
    const fix = state.gps.fix;
    if (!fix || Date.now() - fix.receivedAt > MAX_FIX_AGE) return toast(noFixMessage());
    if (fix.accuracy > PLACE_MAX_ACCURACY) {
      view.panTo(toLocal(state.placement, fix), 17);
      return toast(`위치 오차가 커요(±${Math.round(fix.accuracy)}m) — 지도를 내 위치(파란 점)로 옮겼어요. 내가 선 곳을 탭하거나, 오차가 줄면 다시 누르세요`);
    }
    placeAt(fix, { fit: true });
  });
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
  $('#place-reset').addEventListener('click', () => {
    if (isReal(state.placement)) return toast(`이미 ${state.area.name} 실제 위치예요`);
    if (!confirm(`건물 배치를 ${state.area.name} 실제 위치로 되돌릴까요? 지금 옮긴 배치는 사라져요.`)) return;
    setPlacement(realPlacement());
    view.fit();
    toast(`${state.area.name} 실제 위치로 되돌렸어요`);
  });
  $('#test-mode').addEventListener('change', (e) => {
    state.testMode = e.target.checked;
    saveSetting('testMode', state.testMode);
    refresh(); // the preview goes blind (or comes back) right away
  });
  $('#export').addEventListener('click', exportVisits);
  $('#reset').addEventListener('click', () => {
    if (!confirm('방문 기록을 모두 지울까요? 내보내지 않은 기록은 되돌릴 수 없어요.')) return;
    state.visits = [];
    resetGeneration++;
    unsaved.clear();
    unsavedPhotos.clear();
    clearAll().catch(() => toast('저장된 기록을 지우지 못했어요'));
    refresh();
  });
}

async function start() {
  bindControls();
  let area;
  try {
    const res = await fetch('data/deoksugung.json');
    if (!res.ok) throw new Error(res.status);
    area = await res.json();
  } catch {
    $('#start-note').textContent = '건물 데이터를 불러오지 못했어요. 새로고침해 주세요.';
    return;
  }
  state.area = area;
  state.areaHash = hashText(JSON.stringify(area.buildings));
  state.buildings = withZones(area.buildings);
  for (const el of [$('#title'), $('#start-title')]) el.textContent = `${area.name} 방문 체크`;
  document.title = `${area.name} 방문 체크`;
  state.testMode = loadSetting('testMode', false);
  $('#test-mode').checked = state.testMode;
  // Storage must never block the app: shots taken before this resolves are merged in.
  loadVisits()
    .then((loaded) => {
      const fresh = new Set(state.visits.map((v) => v.id));
      state.visits = [...loaded.filter((v) => !fresh.has(v.id)), ...state.visits];
      refresh();
    })
    .catch(() => toast('저장된 기록을 불러오지 못했어요 — 이 브라우저에서는 저장이 안 될 수 있어요'));
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
  $('#start-note').textContent = '앱을 시작하지 못했어요. 새로고침해 주세요. (방금 업데이트됐다면 1~2분 뒤 다시)';
});
