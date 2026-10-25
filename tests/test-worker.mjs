import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });

const edgeStored = new Map();
globalThis.caches = {
  default: {
    async match(key) {
      const hit = edgeStored.get(key.url);
      return hit ? hit.clone() : undefined;
    },
    async put(key, response) {
      edgeStored.set(key.url, response.clone());
    },
  },
};

const r2Stored = new Map();
const r2 = {
  async get(key) {
    if (!r2Stored.has(key)) return null;
    return { body: new Response(r2Stored.get(key)).body };
  },
  async put(key, value, options = {}) {
    let stored;
    if (typeof value === 'string') stored = value;
    else if (value instanceof ReadableStream) stored = Buffer.from(await new Response(value).arrayBuffer());
    else if (value instanceof Uint8Array || Buffer.isBuffer(value)) stored = Buffer.from(value);
    else stored = String(value);
    r2Stored.set(key, stored);
    return { key, size: typeof stored === 'string' ? Buffer.byteLength(stored) : stored.length, options };
  },
};

const { handleApiRequest } = await import('../src/worker.js');
const bbox = { s: 30.4, w: 47.5, n: 30.5, e: 47.6 };

async function callFeatures(source, ctx, env = {}) {
  return handleApiRequest(new Request('https://rw-map-forge.pages.dev/api/terrain-features', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bbox, source }),
  }), ctx, env);
}
function ctxWithWaitUntil(pending = []) {
  return { pending, waitUntil(p) { this.pending.push(p); } };
}
const fakeFeatureCollection = {
  features: [{
    attributes: { name: 'Test lake' },
    geometry: { rings: [[[47.51, 30.41], [47.59, 30.41], [47.59, 30.49], [47.51, 30.49], [47.51, 30.41]]] },
  }],
};

{
  edgeStored.clear();
  r2Stored.clear();
  const pending = [];
  let upstreamCalls = 0;
  globalThis.fetch = async (input, options) => {
    upstreamCalls++;
    const url = new URL(String(input));
    assert.equal(url.hostname, 'services2.arcgis.com');
    assert.ok(options.headers.accept.includes('application/json'));
    assert.equal(url.searchParams.get('outSR'), '4326');
    assert.equal(url.searchParams.get('f'), 'json');
    assert.equal(url.searchParams.get('geometryType'), 'esriGeometryEnvelope');
    assert.equal(url.searchParams.get('geometry'), '47.5,30.4,47.6,30.5');
    assert.equal(url.searchParams.get('where'), '1=1');
    assert.equal(url.searchParams.get('maxAllowableOffset'), '0.0005');
    assert.equal(url.searchParams.get('geometryPrecision'), '5');
    assert.equal(url.pathname.endsWith('/FeatureServer/0/query'), true);
    return new Response(JSON.stringify(fakeFeatureCollection), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const ctx = ctxWithWaitUntil(pending);
  const res = await callFeatures('water', ctx, { TERRAIN_CACHE: r2 });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-terrain-source'), 'upstream');
  assert.equal(res.headers.get('x-terrain-cache'), 'MISS');
  const data = await res.json();
  assert.ok(Array.isArray(data.features));
  assert.equal(data.features.length, 1);
  assert.equal(data.features[0].attributes.name, 'Test lake');
  await Promise.all(pending);
  assert.equal(upstreamCalls, 1);
  assert.equal(r2Stored.size, 1, 'successful feature response should be persisted in R2');
}

{
  // R2 hit must work even if the provider is currently offline.
  globalThis.fetch = async () => { throw new Error('simulated provider outage'); };
  const res = await callFeatures('water', ctxWithWaitUntil(), { TERRAIN_CACHE: r2 });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-terrain-source'), 'R2');
  assert.equal(res.headers.get('x-terrain-cache'), 'HIT');
  const data = await res.json();
  assert.equal(data.features.length, 1);
}

{
  // Use a bbox that has not been cached, so this call exercises the upstream failure path.
  globalThis.fetch = async () => { throw new Error('simulated provider outage'); };
  const otherBboxCall = new Request('https://rw-map-forge.pages.dev/api/terrain-features', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bbox: { s: 31.4, w: 48.5, n: 31.5, e: 48.6 }, source: 'land' }),
  });
  const res = await handleApiRequest(otherBboxCall, ctxWithWaitUntil(), { TERRAIN_CACHE: r2 });
  assert.equal(res.status, 502);
  const data = await res.json();
  assert.match(data.error, /Terrain data source land failed/);
}

{
  // A provider's JSON error must never be cached as a feature collection.
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'Unsupported query format' } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  const res = await callFeatures('rivers', ctxWithWaitUntil());
  assert.equal(res.status, 502);
  const data = await res.json();
  assert.match(data.error, /did not return a valid feature collection/);
}

{
  // A completed R2 import is advertised through the manifest; the tile route then
  // serves gzip-compressed vector/raster tiles without calling any public map API.
  edgeStored.clear();
  r2Stored.clear();
  const manifest = {
    ready: true,
    datasetVersion: 'global-v1',
    generatedAt: '2026-01-01T00:00:00Z',
    statusMessage: 'ready',
    rivers: { nonEmptyCells: 123 },
    water: { nonEmptyCells: 456 },
    roads: { nonEmptyCells: 78 },
    landcover: { tiles: 648 },
  };
  r2Stored.set('global/v1/manifest.json', JSON.stringify(manifest));
  const collection = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { HYRIV_ID: 42, ORD_STRA: 3 },
      geometry: { type: 'LineString', coordinates: [[47.5, 30.4], [47.6, 30.5]] },
    }],
  };
  r2Stored.set('global/v1/hydro/rivers/45_90.geojson.gz', gzipSync(Buffer.from(JSON.stringify(collection))));
  const landValues = Buffer.alloc(400 * 400, 5);
  r2Stored.set('global/v1/landcover/3_2.bin.gz', gzipSync(landValues));

  const ctx = ctxWithWaitUntil();
  const statusRes = await handleApiRequest(new Request('https://rw-map-forge.pages.dev/api/terrain-status'), ctx, { TERRAIN_CACHE: r2 });
  assert.equal(statusRes.status, 200);
  const status = await statusRes.json();
  assert.equal(status.ready, true);
  assert.equal(status.tileCounts.rivers, 123);
  await Promise.all(ctx.pending);

  const hydroRes = await handleApiRequest(new Request('https://rw-map-forge.pages.dev/api/hydro-tile?source=rivers&x=90&y=45'), ctxWithWaitUntil(), { TERRAIN_CACHE: r2 });
  assert.equal(hydroRes.status, 200);
  assert.equal(hydroRes.headers.get('content-type'), 'application/gzip');
  const decodedHydro = JSON.parse(gunzipSync(Buffer.from(await hydroRes.arrayBuffer())).toString('utf8'));
  assert.equal(decodedHydro.features[0].properties.HYRIV_ID, 42);

  const emptyRes = await handleApiRequest(new Request('https://rw-map-forge.pages.dev/api/hydro-tile?source=water&x=91&y=45'), ctxWithWaitUntil(), { TERRAIN_CACHE: r2 });
  assert.equal(emptyRes.status, 200);
  assert.equal(emptyRes.headers.get('x-global-tile-empty'), '1');
  assert.equal((await emptyRes.json()).features.length, 0);

  const landRes = await handleApiRequest(new Request('https://rw-map-forge.pages.dev/api/landcover-tile?x=2&y=3'), ctxWithWaitUntil(), { TERRAIN_CACHE: r2 });
  assert.equal(landRes.status, 200);
  assert.equal(landRes.headers.get('x-global-tile-format'), 'uint8-gzip');
  const decodedLand = gunzipSync(Buffer.from(await landRes.arrayBuffer()));
  assert.equal(decodedLand.length, 400 * 400);
  assert.equal(decodedLand[0], 5);
}

console.log('Worker R2 terrain cache tests passed.');
