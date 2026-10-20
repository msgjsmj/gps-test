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

// Which edge of the phone is up in the screen plane, from gravity alone (W3C Euler angles:
// "up" in device coordinates is (-cos b sin g, sin b, cos b cos g)), so it works with the
// screen-rotation lock on. 0 = portrait, 90 = top edge to the left (turned counter-clockwise),
// -90 = top edge to the right, ±180 = upside down; null when the phone lies nearly flat.
export function screenRoll(beta, gamma) {
  const ux = -Math.cos(beta * DEG) * Math.sin(gamma * DEG);
  const uy = Math.sin(beta * DEG);
  if (Math.hypot(ux, uy) < 0.5) return null;
  return Math.atan2(ux, uy) / DEG;
}

// iOS reports webkitCompassHeading against the phone's natural (portrait) orientation: held
// upright in portrait it reads the camera direction, but turned to landscape it follows the
// top edge, 90° off the camera. Degrees to add to turn it back: +90 with the top edge to the
// left, -90 to the right, 0 otherwise (portrait, upside down, flat).
export function landscapeCorrection(beta, gamma) {
  const roll = screenRoll(beta, gamma);
  if (roll === null) return 0;
  if (roll > 45 && roll < 135) return 90;
  if (roll < -45 && roll > -135) return -90;
  return 0;
}

const rawAngles = (e) => ({ alpha: e.alpha, beta: e.beta, gamma: e.gamma, screenAngle: screen.orientation?.angle ?? window.orientation ?? null });

// onHeading({ value, accuracy|null, source, correction, raw }). value is the bearing the back
// camera faces, from MAGNETIC north (both platforms); correction is what was added for a
// landscape-held iPhone; raw keeps the event angles so a wrong formula can be corrected from
// recorded data. Returns a stop function.
export function watchHeading(onHeading) {
  const ios = (e) => {
    const compass = e.webkitCompassHeading;
    if (!Number.isFinite(compass) || compass < 0) return; // negative = not calibrated
    const correction = landscapeCorrection(e.beta ?? 90, e.gamma ?? 0);
    onHeading({
      value: (((compass + correction) % 360) + 360) % 360,
      accuracy: e.webkitCompassAccuracy ?? null,
      source: 'ios-webkit',
      correction,
      raw: { ...rawAngles(e), webkitCompassHeading: compass },
    });
  };
  const absolute = (e) => {
    if (!Number.isFinite(e.alpha)) return;
    // The camera axis itself does not move when the phone is turned to landscape: no correction.
    onHeading({ value: backCameraHeading(e.alpha, e.beta ?? 0, e.gamma ?? 0), accuracy: null, source: 'absolute', correction: 0, raw: rawAngles(e) });
  };
  if ('ondeviceorientationabsolute' in window) {
    window.addEventListener('deviceorientationabsolute', absolute);
    return () => window.removeEventListener('deviceorientationabsolute', absolute);
  }
  window.addEventListener('deviceorientation', ios);
  return () => window.removeEventListener('deviceorientation', ios);
}
