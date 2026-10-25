import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const mod = { exports: {} };
vm.runInNewContext(readFileSync(new URL('../public/js/arcgis.js', import.meta.url), 'utf8'), {
  module: mod,
  console,
});
const A = mod.exports;
const bbox = { s: 30.4, w: 47.5, n: 30.5, e: 47.6 };
const ring = [[47.49, 30.39], [47.61, 30.39], [47.61, 30.51], [47.49, 30.51], [47.49, 30.39]];

function assertClipped(elements) {
  const points = [];
  for (const element of elements) {
    if (Array.isArray(element.geometry)) points.push(...element.geometry);
    for (const member of element.members || []) if (Array.isArray(member.geometry)) points.push(...member.geometry);
  }
  assert.ok(points.length > 0, 'converted geometry should have coordinates');
  for (const p of points) {
    assert.ok(p.lon >= bbox.w - 1e-8 && p.lon <= bbox.e + 1e-8, 'longitude must remain inside map bounds');
    assert.ok(p.lat >= bbox.s - 1e-8 && p.lat <= bbox.n + 1e-8, 'latitude must remain inside map bounds');
  }
}

{
  const result = A.featureToElements({
    attributes: { OBJECTID: 1, Name1: 'test lake' },
    geometry: { rings: [ring] },
  }, 'water', bbox, 1);
  assert.equal(result.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(result[0].tags)), { natural: 'water' });
  assertClipped(result);
}

{
  const result = A.featureToElements({
    attributes: { OBJECTID: 2 },
    geometry: { paths: [[[47.49, 30.45], [47.61, 30.45]]] },
  }, 'rivers', bbox, 10);
  assert.equal(result.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(result[0].tags)), { waterway: 'river' });
  assertClipped(result);
  assert.equal(result[0].geometry[0].lon, bbox.w);
  assert.equal(result[0].geometry[result[0].geometry.length - 1].lon, bbox.e);
}

{
  const result = A.featureToElements({
    attributes: { Land_cover: 'Deserts' },
    geometry: { rings: [ring] },
  }, 'land', bbox, 20);
  assert.equal(result.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(result[0].tags)), { natural: 'desert' });
  assertClipped(result);
}

{
  const result = A.featureToElements({
    attributes: { land_cover: 'Temperate Forests' },
    geometry: { rings: [ring] },
  }, 'land', bbox, 30);
  assert.deepEqual(JSON.parse(JSON.stringify(result[0].tags)), { natural: 'wood' });
}

{
  const result = A.featureToElements({
    properties: { ne_id: 99, type: 'Major Highway', name: 'test road' },
    geometry: { type: 'LineString', coordinates: [[47.49, 30.45], [47.61, 30.45]] },
  }, 'roads', bbox, 40);
  assert.equal(result.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(result[0].tags)), { highway: 'primary' });
  assertClipped(result);
}

{
  assert.deepEqual(JSON.parse(JSON.stringify(A.roadTags({ type: 'Freeway' }))), { highway: 'motorway' });
  assert.deepEqual(JSON.parse(JSON.stringify(A.roadTags({ type: 'Secondary Highway' }))), { highway: 'secondary' });
  assert.equal(A.roadTags({ type: 'Ferry' }), null);
}

console.log('ArcGIS conversion tests passed.');
