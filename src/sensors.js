// Device sensors: GPS position and compass heading, normalized for the app.

// Keeps GPS warm from the start; cold fixes are slow and inaccurate.
export function watchPosition(onFix, onError) {
  if (!('geolocation' in navigator)) {
    onError({ code: 0, message: '이 브라우저는 위치 기능을 지원하지 않아요' });
    return () => {};
  }
  const id = navigator.geolocation.watchPosition(
    // at = the fix's own timestamp (recorded); receivedAt = local clock, used for staleness
    (pos) => onFix({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy, at: pos.timestamp, receivedAt: Date.now() }),
    (err) => onError(err),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 },
  );
  return () => navigator.geolocation.clearWatch(id);
}

// iOS needs a permission prompt from inside a tap handler; elsewhere this resolves immediately.
export async function requestHeadingPermission() {
  const request = window.DeviceOrientationEvent?.requestPermission;
  if (typeof request !== 'function') return 'granted';
  try {
    return await request.call(DeviceOrientationEvent);
  } catch {
    return 'denied';
  }
}

const DEG = Math.PI / 180;

// Bearing the back camera faces, from absolute Euler angles (W3C DeviceOrientation
// spec worked example). Falls back to the top-edge bearing when the phone lies flat.
export function backCameraHeading(alpha, beta, gamma) {
  const [cx, cy, cz] = [Math.cos(beta * DEG), Math.cos(gamma * DEG), Math.cos(alpha * DEG)];
  const [sx, sy, sz] = [Math.sin(beta * DEG), Math.sin(gamma * DEG), Math.sin(alpha * DEG)];
  const vx = -cz * sy - sz * sx * cy; // east component of the camera axis
  const vy = -sz * sy + cz * sx * cy; // north component
  if (Math.hypot(vx, vy) < 0.3) return (360 - alpha) % 360;
  return ((Math.atan2(vx, vy) / DEG) + 360) % 360;
}

const rawAngles = (e) => ({ alpha: e.alpha, beta: e.beta, gamma: e.gamma, screenAngle: screen.orientation?.angle ?? window.orientation ?? null });

// onHeading({ value, accuracy|null, source, raw }). value is a bearing from
// MAGNETIC north (both platforms); raw keeps the event angles so a wrong
// formula can be corrected from recorded data. Returns a stop function.
export function watchHeading(onHeading) {
  const ios = (e) => {
    const value = e.webkitCompassHeading;
    if (!Number.isFinite(value) || value < 0) return; // negative = not calibrated
    onHeading({ value, accuracy: e.webkitCompassAccuracy ?? null, source: 'ios-webkit', raw: { ...rawAngles(e), webkitCompassHeading: value } });
  };
  const absolute = (e) => {
    if (!Number.isFinite(e.alpha)) return;
    onHeading({ value: backCameraHeading(e.alpha, e.beta ?? 0, e.gamma ?? 0), accuracy: null, source: 'absolute', raw: rawAngles(e) });
  };
  if ('ondeviceorientationabsolute' in window) {
    window.addEventListener('deviceorientationabsolute', absolute);
    return () => window.removeEventListener('deviceorientationabsolute', absolute);
  }
  window.addEventListener('deviceorientation', ios);
  return () => window.removeEventListener('deviceorientation', ios);
}
