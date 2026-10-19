// Controller: holds state, turns sensor readings into judgments, records visits.

import { cameraLive, cameraSupported, captureFrame, closeCamera, openCamera } from './camera.js';
import { dist, normDeg, toGeo, toLocal } from './geo.js';
import { JUDGE_DEFAULTS, PARAMS_VERSION, judge } from './judge.js';
import { createMapView } from './map-view.js';
import { requestHeadingPermission, watchHeading, watchPosition } from './sensors.js';
import { loadSetting, saveSetting } from './store.js';
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
  gps: { fix: null, error: null, stop: null, centered: false },
  compass: { reading: null, stop: null, denied: false },
  useHeading: false,
  showZones: true,
  placing: false, // next map tap moves the layout
  visits: [],
};

const view = createMapView($('#map'), {
  onMapClick: tapMap,
  // In simulation (or while placing) a tap on a building is still a map tap; otherwise it focuses the building.
  onBuildingClick: (id, point) => (state.mode === 'sim' || state.placing ? tapMap(point) : view.focus(id)),
  onLocate() {
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
const isReal = (p) => p.anchor.lat === state.area.anchor.lat && p.anchor.lng === state.area.anchor.lng && !p.rotationDeg;
const validPlacement = (p) => Number.isFinite(p?.anchor?.lat) && Number.isFinite(p?.anchor?.lng) && Number.isFinite(p?.rotationDeg);

// The local frame moves with the layout: a simulated point stays at the same spot in the palace.
function setPlacement(next) {
  state.placement = next;
  saveSetting(placementKey(), next);
  view.setArea(state.area, state.buildings, next);
  $('#rotation').value = next.rotationDeg;
  $('#rotation-out').textContent = next.rotationDeg;
  const offKm = dist(toLocal(realPlacement(), next.anchor), [0, 0]) / 1000;
  $('#placement-status').textContent = isReal(next)
    ? `실제 위치 (${state.area.name})`
    : `옮김 · 실제 위치에서 ${offKm.toFixed(1)}km · 회전 ${next.rotationDeg}°`;
  refresh();
}

function placeAt({ lat, lng }) {
  state.placing = false;
  document.body.classList.remove('placing');
  setPlacement({ anchor: { lat, lng }, rotationDeg: state.placement.rotationDeg });
  view.fit();
  toast(`${state.area.name} 배치를 옮겼어요`, true);
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
const visitedIds = () => new Set(state.visits.map((v) => v.buildingId).filter(Boolean));
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
  const { result } = j;
  if (!result.best) return ['근처에 촬영 대상 건물이 없어요', acc];
  const others = result.ranked.slice(1, 3).map((r) => `${nameOf(r.id)} ${pct(r.p)}`);
  return [`지금 찍으면 → ${nameOf(result.best)} (${pct(result.ranked[0].p)})`, [...others, acc].join(' · ')];
}

function sensorText(obs) {
  if (state.mode === 'sim') return state.useHeading ? `방향 ${state.sim.heading}°` : '';
  const parts = [];
  const fix = state.gps.fix;
  if (fix) parts.push(`GPS ±${Math.round(fix.accuracy)}m${Date.now() - fix.receivedAt > WARN_FIX_AGE ? ` (${secondsAgo(fix.receivedAt)}초 전)` : ''}`);
  if (state.gps.error && fix) parts.push(state.gps.error);
  if (obs?.heading) parts.push(`방향 ${Math.round(obs.heading.value)}°`);
  else if (state.compass.denied) parts.push('방향 권한 없음');
  else if (state.compass.stop) parts.push('방향 대기 중');
  return parts.join(' · ');
}

function refresh() {
  const obs = observe();
  const j = obs && judgeBoth(obs, { preview: true });
  view.setPosition(obs && { point: obs.point, accuracy: obs.fix.accuracy, heading: obs.localHeading });
  view.render({ visited: visitedIds(), candidateId: j?.result.best, showZones: state.showZones });
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

const GPS_ERRORS = { 1: '위치 권한이 거부됐어요 — 브라우저 설정에서 허용해 주세요', 2: '위치를 확인할 수 없어요', 3: '위치 응답이 늦어요 — 계속 시도 중' };

function startGps() {
  if (state.gps.stop) return;
  if (!window.isSecureContext) {
    state.gps.error = 'HTTPS 주소에서만 위치를 쓸 수 있어요';
    return;
  }
  state.gps.stop = watchPosition(
    (fix) => {
      state.gps.fix = fix;
      state.gps.error = null;
      if (!state.gps.centered) {
        state.gps.centered = true;
        const point = toLocal(state.placement, fix);
        const far = dist(point, [0, 0]);
        if (far < 2000) view.panTo(point);
        else toast(`${state.area.name}에서 ${(far / 1000).toFixed(1)}km 떨어져 있어요`);
      }
      scheduleRefresh();
    },
    (err) => {
      state.gps.error = GPS_ERRORS[err.code] ?? err.message;
      if (err.code === 1) {
        // denied: the watch is dead; a later tap on ◎ or a mode switch retries
        state.gps.stop?.();
        state.gps.stop = null;
      }
      scheduleRefresh();
    },
  );
}

function stopGps() {
  state.gps.stop?.();
  Object.assign(state.gps, { stop: null, fix: null, error: null, centered: false });
}

// Must be called synchronously inside a tap handler (iOS permission prompt).
function startCompass() {
  if (state.compass.stop) return;
  requestHeadingPermission().then((perm) => {
    if (perm !== 'granted') {
      state.compass.denied = true;
      return scheduleRefresh();
    }
    state.compass.denied = false;
    state.compass.stop ??= watchHeading((h) => {
      const declination = state.area.declination ?? 0;
      state.compass.reading = { ...h, magnetic: h.value, value: normDeg(h.value + declination), declination, at: Date.now() };
      scheduleRefresh();
    });
  });
}

function stopCompass() {
  state.compass.stop?.();
  Object.assign(state.compass, { stop: null, reading: null });
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
  return new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.8));
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
    photo: await photoPromise.catch(() => null),
    photoKind,
  };
  state.visits.push(visit);
  if (visit.buildingId) toast(`✓ ${nameOf(visit.buildingId)} 방문 체크!`, true);
  else toast('근처에 촬영 대상 건물이 없어서 체크하지 않았어요');
  refresh();
}

const noFixMessage = () => (state.mode === 'sim' ? '먼저 지도를 탭해서 위치를 정하세요' : state.gps.error ?? '아직 위치를 못 잡았어요');

function shootSimulated() {
  const obs = observe();
  if (!obs) return toast(noFixMessage());
  record(obs, judgeBoth(obs), simulatedPhoto(obs), 'simulated');
}

async function openShutter() {
  if (!$('#camera').hidden) return; // already open or opening
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
    toast('카메라를 열 수 없어 가상 사진으로 기록해요');
    shootSimulated();
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
  el.textContent = text;
  el.className = ok ? 'toast ok' : 'toast';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2500);
}

// Thumbnails live only while the records dialog is open.
let thumbUrls = [];
function renderRecords() {
  $('#record-list').replaceChildren(
    ...state.buildings.map((b) => {
      const mine = state.visits.filter((v) => v.buildingId === b.id);
      const li = document.createElement('li');
      li.className = mine.length ? 'done' : '';
      const mark = Object.assign(document.createElement('span'), { className: 'mark', textContent: mine.length ? '✓' : '○' });
      const name = Object.assign(document.createElement('button'), { type: 'button', textContent: mine.length > 1 ? `${b.name} (${mine.length}장)` : b.name });
      name.addEventListener('click', () => {
        $('#records').close();
        view.focus(b.id);
      });
      const photo = mine.findLast((v) => v.photo)?.photo;
      let thumb = document.createElement('span');
      if (photo) {
        const url = URL.createObjectURL(photo);
        thumbUrls.push(url);
        thumb = Object.assign(document.createElement('img'), { src: url, alt: `${b.name} 사진` });
      }
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
  document.addEventListener('visibilitychange', () => document.hidden && !$('#camera').hidden && closeShutter());
  $('#open-settings').addEventListener('click', () => {
    state.placing = false; // opening settings cancels a pending "tap to place"
    document.body.classList.remove('placing');
    $('#settings').showModal();
  });
  $('#progress').addEventListener('click', () => {
    renderRecords();
    $('#records').showModal();
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
  $('#place-here').addEventListener('click', () => {
    const fix = state.gps.fix;
    if (!fix || Date.now() - fix.receivedAt > MAX_FIX_AGE) return toast(noFixMessage());
    $('#settings').close();
    placeAt(fix);
  });
  $('#place-tap').addEventListener('click', () => {
    $('#settings').close();
    state.placing = true;
    document.body.classList.add('placing');
    toast(`${state.area.name} 중심을 둘 곳을 지도에서 탭하세요`);
  });
  $('#rotation').addEventListener('input', (e) => setPlacement({ ...state.placement, rotationDeg: Number(e.target.value) }));
  $('#place-reset').addEventListener('click', () => {
    setPlacement(realPlacement());
    view.fit();
  });
  $('#reset').addEventListener('click', () => {
    if (!confirm('방문 기록을 모두 지울까요?')) return;
    state.visits = [];
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
  const saved = loadSetting(placementKey(), null);
  setPlacement(validPlacement(saved) ? saved : realPlacement());
  view.fit();
  for (const b of [$('#start-gps'), $('#start-sim')]) b.disabled = false;
}

start();
