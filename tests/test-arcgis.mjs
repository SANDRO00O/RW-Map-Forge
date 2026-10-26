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
  // The imported R2 GeoJSON must still convert if a source emits latitude /
  // longitude order. The converter only swaps when that orientation alone
  // intersects the chosen map's bounds.
  const mapBounds = { s: 46.52, w: 7.95, n: 46.58, e: 8.05 };
  const swappedLineStats = {};
  const river = A.featureToElements({
    properties: { HYRIV_ID: 123 },
    geometry: { type: 'MultiLineString', coordinates: [
      [[46.50, 7.98], [46.60, 7.98]],
    ] },
  }, 'rivers', mapBounds, 50, swappedLineStats);
  assert.equal(river.length, 1);
  assert.equal(swappedLineStats.axisSwapped, 1);
  assert.ok(Math.abs(river[0].geometry[0].lat - mapBounds.s) < 1e-8);
  assert.ok(Math.abs(river[0].geometry[river[0].geometry.length - 1].lat - mapBounds.n) < 1e-8);
  assertClippedTo(river, mapBounds);

  const mapRing = [[46.50, 7.90], [46.60, 7.90], [46.60, 8.10], [46.50, 8.10], [46.50, 7.90]];
  const lakeStats = {};
  const lake = A.featureToElements({
    properties: { HYLAK_ID: 456 },
    geometry: { type: 'Polygon', coordinates: [mapRing] },
  }, 'water', mapBounds, 60, lakeStats);
  assert.equal(lake.length, 1);
  assert.equal(lakeStats.axisSwapped, 1);
  assertClippedTo(lake, mapBounds);
}

function assertClippedTo(elements, bounds) {
  const points = [];
  for (const element of elements) {
    if (Array.isArray(element.geometry)) points.push(...element.geometry);
    for (const member of element.members || []) if (Array.isArray(member.geometry)) points.push(...member.geometry);
  }
  assert.ok(points.length > 0, 'converted geometry should have coordinates');
  for (const p of points) {
    assert.ok(p.lon >= bounds.w - 1e-8 && p.lon <= bounds.e + 1e-8, 'longitude must remain inside map bounds');
    assert.ok(p.lat >= bounds.s - 1e-8 && p.lat <= bounds.n + 1e-8, 'latitude must remain inside map bounds');
  }
}

{
  assert.deepEqual(JSON.parse(JSON.stringify(A.roadTags({ type: 'Freeway' }))), { highway: 'motorway' });
  assert.deepEqual(JSON.parse(JSON.stringify(A.roadTags({ type: 'Secondary Highway' }))), { highway: 'secondary' });
  assert.deepEqual(JSON.parse(JSON.stringify(A.roadTags({ type: 'Minor Highway' }))), { highway: 'tertiary' });
  assert.equal(A.roadTags({ type: 'Ferry' }), null);
}

console.log('ArcGIS conversion tests passed.');
