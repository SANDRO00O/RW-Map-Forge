import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

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
    let text;
    if (typeof value === 'string') text = value;
    else if (value instanceof ReadableStream) text = await new Response(value).text();
    else text = String(value);
    r2Stored.set(key, text);
    return { key, size: text.length, options };
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

console.log('Worker R2 terrain cache tests passed.');
