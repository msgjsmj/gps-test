import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = (name) => JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url)));
const area = read('deoksugung.json');
const guide = read('deoksugung-guide.json');

test('every building opens a description with text', () => {
  const places = new Map(guide.places.map((p) => [p.key, p]));
  for (const b of area.buildings) {
    const place = places.get(guide.buildingPlace[b.id]);
    assert.ok(place, `${b.id} has no description (add it to BUILDING_PLACE in tools/import-guide.mjs)`);
    assert.ok(place.summary && place.paragraphs.length, `${place.key} is empty`);
  }
});

test('every building has a credited photo that exists', () => {
  const photos = read('building-photos.json');
  for (const b of area.buildings) {
    const photo = photos[b.id];
    assert.ok(photo, `${b.id} has no photo`);
    assert.ok(existsSync(new URL(`../${photo.file}`, import.meta.url)), `${photo.file} is missing`);
    assert.ok(photo.author && photo.license && photo.page, `${b.id} lacks its credit`);
  }
});
