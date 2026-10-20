import test from 'node:test';
import assert from 'node:assert/strict';
import { backCameraHeading, landscapeCorrection, screenRoll } from '../src/sensors.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test('upright phone: back camera faces where the top edge pointed when flat', () => {
  close(backCameraHeading(0, 90, 0), 0); // alpha 0 = top edge north
  close(backCameraHeading(90, 90, 0), 270); // alpha grows counter-clockwise → west
  close(backCameraHeading(270, 90, 0), 90);
});

test('slightly tilted upright phone still reads the camera bearing', () => {
  close(backCameraHeading(0, 70, 5), 360 - Math.atan2(Math.sin(5 * Math.PI / 180) * 1, Math.sin(70 * Math.PI / 180) * Math.cos(5 * Math.PI / 180)) * 180 / Math.PI, 1e-9);
});

test('flat phone falls back to the top-edge bearing', () => {
  close(backCameraHeading(30, 0, 0), 330);
});

// screenRoll: which edge is up in the screen plane, from gravity (beta/gamma only, so it works with
// rotation lock on). 0 portrait, 90 = top edge to the left (turned counter-clockwise), -90 = to the right.
test('screen roll from gravity: portrait, both landscapes, upside down, flat', () => {
  close(screenRoll(90, 0), 0);
  close(screenRoll(0, -90), 90);
  close(screenRoll(0, 90), -90);
  close(Math.abs(screenRoll(-90, 0)), 180);
  assert.equal(screenRoll(0, 0), null); // lying flat: no edge is up
  assert.ok(Math.abs(screenRoll(75, 8)) < 15); // a slightly tilted portrait stays portrait
});

test('iOS landscape heading is turned back to the camera direction; portrait is left alone', () => {
  assert.equal(landscapeCorrection(90, 0), 0); // portrait already reads the camera direction
  assert.equal(landscapeCorrection(5, -85), 90); // top edge left: compass points 90 deg left of the camera
  assert.equal(landscapeCorrection(-5, 88), -90); // top edge right
  assert.equal(landscapeCorrection(70, -30), 0); // only a little tilted: still portrait
  assert.equal(landscapeCorrection(-90, 0), 0); // upside down: unknown, leave as is
  assert.equal(landscapeCorrection(0, 0), 0); // flat
});

test('Android back-camera heading does not change when the phone is turned to landscape', () => {
  // R = Rz(alpha) Rx(beta) Ry(gamma); turning the phone in the screen plane is R · Rz(roll), which
  // leaves the camera axis (-z) where it was. Re-extract the Euler angles and compare headings.
  const D = Math.PI / 180;
  const mul = (A, B) => A.map((r, i) => B[0].map((_, j) => r.reduce((s, _, k) => s + A[i][k] * B[k][j], 0)));
  const Rz = (a) => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];
  const Rx = (b) => [[1, 0, 0], [0, Math.cos(b), -Math.sin(b)], [0, Math.sin(b), Math.cos(b)]];
  const Ry = (g) => [[Math.cos(g), 0, Math.sin(g)], [0, 1, 0], [-Math.sin(g), 0, Math.cos(g)]];
  const euler = (R) => [Math.atan2(-R[0][1], R[1][1]) / D, Math.asin(R[2][1]) / D, Math.atan2(-R[2][0], R[2][2]) / D];
  for (const [alpha, beta, gamma] of [[0, 85, 0], [120, 80, 5], [250, 95, -3]]) {
    const portrait = mul(mul(Rz(alpha * D), Rx(beta * D)), Ry(gamma * D));
    const h = backCameraHeading(alpha, beta, gamma);
    for (const roll of [90, -90]) {
      const [a, b, g] = euler(mul(portrait, Rz(roll * D)));
      const turned = backCameraHeading((a + 360) % 360, b, g);
      const gap = Math.abs(((turned - h + 540) % 360) - 180);
      assert.ok(gap < 1e-6, `alpha ${alpha} roll ${roll}: ${h} vs ${turned}`);
    }
  }
});
