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

async function callFeatures(source, ctx) {
  return handleApiRequest(new Request('https://rw-map-forge.pages.dev/api/terrain-features', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bbox, source }),
  }), ctx);
}

{
  stored.clear();
  const pending = [];
  const fakeFeatureCollection = {
    features: [{
      attributes: { name: 'Test lake' },
      geometry: { rings: [[[47.51, 30.41], [47.59, 30.41], [47.59, 30.49], [47.51, 30.49], [47.51, 30.41]]] },
    }],
  };
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'services2.arcgis.com');
    assert.ok(options.headers.accept.includes('application/geo+json'));
    assert.equal(url.searchParams.get('outSR'), '4326');
    assert.equal(url.searchParams.get('f'), 'json');
    assert.equal(url.searchParams.get('geometryType'), 'esriGeometryEnvelope');
    assert.equal(url.searchParams.get('geometry'), '47.5,30.4,47.6,30.5');
    assert.equal(url.searchParams.get('where'), '1=1');
    assert.equal(url.pathname.endsWith('/FeatureServer/0/query'), true);
    return new Response(JSON.stringify(fakeFeatureCollection), {
      status: 200,
      headers: { 'content-type': 'application/geo+json' },
    });
  };

  const res = await callFeatures('water', { waitUntil(p) { pending.push(p); } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-terrain-source'), 'ArcGIS');
  const data = await res.json();
  assert.ok(Array.isArray(data.features));
  assert.equal(data.features.length, 1);
  assert.equal(data.features[0].attributes.name, 'Test lake');
  await Promise.all(pending);
  assert.equal(stored.size, 1);
}

{
  stored.clear();
  globalThis.fetch = async () => { throw new Error('simulated provider outage'); };
  const res = await callFeatures('land', { waitUntil() {} });
  assert.equal(res.status, 502);
  const data = await res.json();
  assert.match(data.error, /ArcGIS land request failed/);
}

{
  stored.clear();
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'Unsupported query format' } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  const res = await callFeatures('rivers', { waitUntil() {} });
  // Pass-through preserves provider diagnostics; fetchArcgisSource turns this into a visible error.
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.error.message, 'Unsupported query format');
}

console.log('Worker ArcGIS proxy tests passed.');
