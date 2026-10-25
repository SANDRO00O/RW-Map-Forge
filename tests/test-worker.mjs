import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });

const stored = new Map();
globalThis.caches = {
  default: {
    async match(key) {
      const hit = stored.get(key.url);
      return hit ? hit.clone() : undefined;
    },
    async put(key, response) {
      stored.set(key.url, response.clone());
    },
  },
};

const { handleApiRequest } = await import('../src/worker.js');
const bbox = { s: 30.4, w: 47.5, n: 30.5, e: 47.6 };
const outsideRing = [[47.49, 30.39], [47.61, 30.39], [47.61, 30.51], [47.49, 30.51], [47.49, 30.39]];
const polygonFeature = (properties = {}) => ({
  type: 'Feature',
  properties,
  geometry: { type: 'Polygon', coordinates: [outsideRing] },
});
const featureCollection = (features) => ({
  type: 'FeatureCollection',
  features,
});

async function callFeatures(ctx) {
  return handleApiRequest(new Request('https://rw-map-forge.pages.dev/api/terrain-features', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bbox, water: true, land: true }),
  }), ctx);
}

{
  stored.clear();
  const midLat = (bbox.s + bbox.n) / 2;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get('outSR'), '4326');
    assert.equal(url.searchParams.get('f'), 'geojson');
    let data;
    if (url.hostname === 'services2.arcgis.com') {
      data = featureCollection([polygonFeature()]);
    } else if (url.pathname.includes('Detailed_Linear_Hydrology')) {
      data = featureCollection([{
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: [[47.49, midLat], [47.61, midLat]] },
      }]);
    } else if (url.pathname.includes('/Land_Cover/')) {
      data = featureCollection([polygonFeature({ Land_cover: 'Deserts' })]);
    } else {
      throw new Error('Unexpected ArcGIS endpoint: ' + url.href);
    }
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'content-type': 'application/geo+json' },
    });
  };

  const pending = [];
  const res = await callFeatures({ waitUntil(p) { pending.push(p); } });
  assert.equal(res.status, 200);
  const data = await res.json();
  await Promise.all(pending);
  assert.ok(Array.isArray(data.elements));
  assert.ok(data.elements.some((e) => e.tags && e.tags.natural === 'water'), 'water polygons should be converted');
  assert.ok(data.elements.some((e) => e.tags && e.tags.waterway === 'river'), 'river lines should be converted');
  assert.ok(data.elements.some((e) => e.tags && e.tags.natural === 'desert'), 'land-cover classes should be converted');

  const points = [];
  for (const element of data.elements) {
    if (Array.isArray(element.geometry)) points.push(...element.geometry);
    for (const member of element.members || []) if (Array.isArray(member.geometry)) points.push(...member.geometry);
  }
  assert.ok(points.length > 0);
  for (const p of points) {
    assert.ok(p.lon >= bbox.w - 1e-8 && p.lon <= bbox.e + 1e-8, 'longitude must be clipped to the map bounds');
    assert.ok(p.lat >= bbox.s - 1e-8 && p.lat <= bbox.n + 1e-8, 'latitude must be clipped to the map bounds');
  }
}

{
  stored.clear();
  globalThis.fetch = async () => { throw new Error('simulated provider outage'); };
  const res = await callFeatures({ waitUntil() {} });
  assert.equal(res.status, 502);
  const data = await res.json();
  assert.match(data.error, /Alternative terrain data services failed/);
}

console.log('Worker terrain-service tests passed.');
