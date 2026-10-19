import test from 'node:test';
import assert from 'node:assert/strict';
import { backCameraHeading } from '../src/sensors.js';

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
