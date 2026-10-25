/**
 * RW Map Forge - Cloudflare Worker
 *
 * Static files are served by Workers Static Assets (see wrangler.toml); this Worker only handles /api/*:
 *
 *   GET  /api/dem?z=&x0=&x1=&y0=&y1=   batch of Terrarium elevation tiles in ONE round trip (fetched in parallel at the edge)
 *   POST /api/terrain-features          global water, river and land-cover features via ArcGIS REST + edge cache
 *   POST /api/osm                       optional Overpass proxy used only for the roads overlay
 *   GET  /api/geocode?q=                Nominatim proxy with a proper User-Agent + edge cache
 *   GET  /api/health
 *
 * The Worker does no heavy computation (free plan CPU limit is ~10 ms per request); all terrain processing
 * runs in a Web Worker inside the visitor's browser.
 */

const UA = 'RWMapForge/1.0 (Rusted Warfare map generator; https://rw-map-forge.pages.dev)';
const DEM_HOSTS = [
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium',
  'https://elevation-tiles-prod.s3.amazonaws.com/terrarium',
];
// Use independent, global Overpass operators. kumi.systems is the old
// hostname for private.coffee, so listing both does not provide a real fallback.
const OVERPASS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];
const MAX_TILES = 40; // the free plan allows 50 subrequests per invocation
const DAY = 86400;

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });

export async function handleApiRequest(request, ctx, workerEnv) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return null;

  try {
    if (url.pathname === '/api/health') return json({ ok: true, terrainCache: !!((workerEnv || (ctx && ctx.env) || {}).TERRAIN_CACHE) });
    if (url.pathname === '/api/dem' && request.method === 'GET') return await handleDem(request, url, ctx);
    if (url.pathname === '/api/terrain-features' && request.method === 'POST') return await handleTerrainFeatures(request, ctx, workerEnv || (ctx && ctx.env) || {});
    if (url.pathname === '/api/osm' && request.method === 'POST') return await handleOsm(request, ctx);
    if (url.pathname === '/api/geocode' && request.method === 'GET') return await handleGeocode(url, ctx);
    return json({ error: 'Not found' }, 404);
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 500);
  }
}

export default {
  async fetch(request, env, ctx) {
    const apiResponse = await handleApiRequest(request, ctx, env);
    if (apiResponse) return apiResponse;
    if (env && env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};

/* ------------------------------------------------------------------ DEM */

function int(url, name, min, max) {
  const v = Number(url.searchParams.get(name));
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(`Invalid parameter: ${name}`);
  return v;
}

async function fetchTile(z, x, y) {
  for (const host of DEM_HOSTS) {
    try {
      const r = await fetch(`${host}/${z}/${x}/${y}.png`, {
        headers: { 'user-agent': UA },
        cf: { cacheTtl: 30 * DAY, cacheEverything: true },
      });
      if (r.ok) return new Uint8Array(await r.arrayBuffer());
    } catch (_) { /* try the next host */ }
  }
  return null;
}

/**
 * Response body: for ty = y0..y1, for tx = x0..x1 (row-major), one record per tile:
 *   uint32 little-endian byteLength (0 when the tile is missing) followed by the PNG bytes.
 */
async function handleDem(request, url, ctx) {
  const z = int(url, 'z', 0, 15);
  const max = (1 << z) - 1;
  const x0 = int(url, 'x0', 0, max), x1 = int(url, 'x1', 0, max);
  const y0 = int(url, 'y0', 0, max), y1 = int(url, 'y1', 0, max);
  if (x1 < x0 || y1 < y0) throw new Error('Invalid tile range');
  const count = (x1 - x0 + 1) * (y1 - y0 + 1);
  if (count > MAX_TILES) throw new Error(`Too many tiles (max ${MAX_TILES})`);

  const cache = caches.default;
  const key = new Request(url.toString(), { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;

  const jobs = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) jobs.push(fetchTile(z, x, y));
  const tiles = await Promise.all(jobs);
  const present = tiles.filter(Boolean).length;
  if (!present) return json({ error: 'Elevation tiles are unavailable right now' }, 502);

  let total = 0;
  for (const t of tiles) total += 4 + (t ? t.length : 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let pos = 0;
  for (const t of tiles) {
    dv.setUint32(pos, t ? t.length : 0, true);
    pos += 4;
    if (t) { out.set(t, pos); pos += t.length; }
  }
  const res = new Response(out, {
    headers: {
      'content-type': 'application/octet-stream',
      'cache-control': `public, max-age=${7 * DAY}`,
      'x-tiles-present': String(present),
      'x-tiles-total': String(count),
    },
  });
  if (present === count) ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

/* -------------------------------------- ArcGIS terrain feature proxy */
const ARCGIS = {
  water: 'https://services2.arcgis.com/IsDCghZ73NgoYoz5/ArcGIS/rest/services/World_Water_Bodies_World/FeatureServer/0/query',
  rivers: 'https://services.arcgis.com/Z58T9dmhcpCmous1/arcgis/rest/services/Detailed_Linear_Hydrology/FeatureServer/0/query',
  land: 'https://services.arcgis.com/8df8p0NlLFEShl0r/arcgis/rest/services/Land_Cover/FeatureServer/0/query',
};

function arcgisQueryUrl(endpoint, bbox, source) {
  const u = new URL(endpoint);
  const p = {
    where: '1=1',
    outFields: source === 'land' ? 'Land_cover' : '*',
    geometry: [bbox.w, bbox.s, bbox.e, bbox.n].join(','),
    geometryType: 'esriGeometryEnvelope',
    spatialRel: 'esriSpatialRelIntersects',
    inSR: '4326',
    outSR: '4326',
    returnGeometry: 'true',
    resultRecordCount: source === 'water' ? '1800' : (source === 'land' ? '900' : '1000'),
    // Generalize large coastlines and water polygons at roughly map-tile scale to reduce payloads.
    maxAllowableOffset: '0.0005',
    geometryPrecision: '5',
    f: 'json',
  };
  Object.keys(p).forEach((k) => u.searchParams.set(k, p[k]));
  return u.toString();
}

function terrainCacheBounds(bbox) {
  // Snap outwards to 0.001 degrees (~111 m latitude) so nearby requests reuse
  // cached features while the browser still clips the geometry to its exact map.
  return {
    s: Math.floor(Number(bbox.s) * 1000) / 1000,
    w: Math.floor(Number(bbox.w) * 1000) / 1000,
    n: Math.ceil(Number(bbox.n) * 1000) / 1000,
    e: Math.ceil(Number(bbox.e) * 1000) / 1000,
  };
}

function terrainCacheKey(source, bbox) {
  const coord = (n) => n.toFixed(3).replace('-', 'm').replace('.', 'p');
  return 'terrain/v1/' + source + '/' +
    coord(bbox.s) + '_' + coord(bbox.w) + '_' + coord(bbox.n) + '_' + coord(bbox.e) + '.json';
}

function terrainCacheResponse(body, source, cacheStatus) {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=' + DAY,
      'x-terrain-source': source,
      'x-terrain-cache': cacheStatus,
    },
  });
}

async function handleTerrainFeatures(request, ctx, env) {
  const input = await request.json();
  const bbox = input && input.bbox;
  const source = input && input.source;
  if (!Object.prototype.hasOwnProperty.call(ARCGIS, source) ||
      !bbox || !['s', 'w', 'n', 'e'].every((k) => Number.isFinite(Number(bbox[k]))) ||
      Number(bbox.s) >= Number(bbox.n) || Number(bbox.w) >= Number(bbox.e) ||
      Math.abs(Number(bbox.s)) > 85 || Math.abs(Number(bbox.n)) > 85 ||
      Math.abs(Number(bbox.w)) > 180 || Math.abs(Number(bbox.e)) > 180) {
    return json({ error: 'Invalid terrain feature request' }, 400);
  }

  const bb = terrainCacheBounds(bbox);
  const objectKey = terrainCacheKey(source, bb);
  const r2 = env && env.TERRAIN_CACHE;

  // Persistent cache is checked before the edge cache. A cached area no longer
  // needs the upstream map-data provider to be available.
  if (r2) {
    try {
      const object = await r2.get(objectKey);
      if (object) return terrainCacheResponse(object.body, 'R2', 'HIT');
    } catch (_) { /* preserve availability by falling back to the edge cache/upstream */ }
  }

  const edgeKey = new Request('https://terrain-cache-v2.invalid/' + encodeURIComponent(objectKey), { method: 'GET' });
  const edgeHit = await caches.default.match(edgeKey);
  if (edgeHit) {
    if (r2) ctx.waitUntil(r2.put(objectKey, edgeHit.clone().body, {
      httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'public, max-age=' + DAY },
      customMetadata: { source: source, cacheVersion: 'v1' },
    }).catch(() => {}));
    return terrainCacheResponse(edgeHit.body, 'edge', 'EDGE-HIT');
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 14000);
  try {
    const upstream = await fetch(arcgisQueryUrl(ARCGIS[source], bb, source), {
      headers: { 'user-agent': UA, 'accept': 'application/json' },
      signal: ctl.signal,
    });
    if (!upstream.ok) return json({ error: 'Terrain data source ' + source + ' returned HTTP ' + upstream.status }, 502);

    const body = await upstream.text();
    const trimmed = body.trimStart();
    if (trimmed.startsWith('{"error"') || trimmed.startsWith('{ "error"') ||
        !/"features"\s*:/.test(trimmed)) {
      return json({ error: 'Terrain data source ' + source + ' did not return a valid feature collection' }, 502);
    }

    const result = terrainCacheResponse(body, 'upstream', 'MISS');
    // Keep both a fast edge cache and a persistent R2 copy. R2 is deliberately
    // best-effort: successful feature data is still returned if storage is unavailable.
    ctx.waitUntil(caches.default.put(edgeKey, result.clone()).catch(() => {}));
    if (r2) ctx.waitUntil(r2.put(objectKey, body, {
      httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'public, max-age=' + DAY },
      customMetadata: {
        source: source,
        cacheVersion: 'v1',
        cachedAt: new Date().toISOString(),
        bounds: JSON.stringify(bb),
      },
    }).catch(() => {}));
    return result;
  } catch (err) {
    if (ctl.signal.aborted) return json({ error: 'Terrain data source ' + source + ' timed out after 14 seconds' }, 502);
    return json({ error: 'Terrain data source ' + source + ' failed: ' + String((err && err.message) || err) }, 502);
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ OSM */

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Try the public Overpass mirrors with bounded wall time. Keep the timeout active
 * until the response body is fully read; fetch() can resolve at headers while the
 * body is still stalled. Reject JSON error remarks so another mirror can be tried.
 */
function hedgedOverpass(query) {
  return new Promise((resolve, reject) => {
    const controllers = new Map();
    const started = new Set();
    let finished = false;
    let failures = 0;
    let lastError = null;
    const MIRROR_TIMEOUT_MS = 30000;

    const launch = (i) => {
      if (finished || i < 0 || i >= OVERPASS.length || started.has(i)) return;
      started.add(i);
      const ctl = new AbortController();
      controllers.set(i, ctl);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        ctl.abort();
      }, MIRROR_TIMEOUT_MS);

      (async () => {
        try {
          const r = await fetch(OVERPASS[i], {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
            body: 'data=' + encodeURIComponent(query),
            signal: ctl.signal,
          });
          const body = await r.text();
          if (!r.ok) {
            const detail = body.replace(/\s+/g, ' ').slice(0, 180);
            throw new Error(`Overpass mirror ${i} replied HTTP ${r.status}${detail ? ': ' + detail : ''}`);
          }

          let data;
          try { data = JSON.parse(body); }
          catch (_) { throw new Error(`Overpass mirror ${i} returned invalid JSON`); }

          const remark = String(data && data.remark || '');
          if (/timed out|timeout|out of memory|query ran out|rate.?limit|server is probably too busy|dispatcher.*(?:off|unavailable)/i.test(remark)) {
            throw new Error(`Overpass mirror ${i}: ${remark.slice(0, 220)}`);
          }
          if (!data || !Array.isArray(data.elements)) {
            throw new Error(`Overpass mirror ${i} returned no elements array`);
          }
          if (finished) return;

          finished = true;
          for (const [j, other] of controllers) if (j !== i) other.abort();
          resolve(new Response(body, {
            status: 200,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          }));
        } catch (err) {
          if (finished) return;
          lastError = timedOut
            ? new Error(`Overpass mirror ${i} timed out after ${Math.round(MIRROR_TIMEOUT_MS / 1000)} seconds`)
            : new Error(`Overpass mirror ${i}: ${String((err && err.message) || err)}`);
          failures++;
          const next = OVERPASS.findIndex((_, j) => !started.has(j));
          if (next >= 0) launch(next);
          else if (failures >= started.size && started.size >= OVERPASS.length) reject(lastError);
        } finally {
          clearTimeout(timer);
        }
      })();
    };

    // Briefly hedge slow mirrors, but cap each full request (including body download).
    launch(0);
    setTimeout(() => launch(1), 5000);
    setTimeout(() => launch(2), 11000);
  });
}

async function handleOsm(request, ctx) {
  const query = await request.text();
  if (!query || query.length > 20000 || !query.startsWith('[out:json]')) return json({ error: 'Invalid query' }, 400);
  const cache = caches.default;
  const key = new Request('https://osm-cache.invalid/' + (await sha256Hex(query)), { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;

  let upstream;
  try {
    upstream = await hedgedOverpass(query);
  } catch (err) {
    return json({ error: 'All Overpass mirrors failed or timed out: ' + ((err && err.message) || err) }, 502);
  }
  const res = new Response(upstream.body, {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${DAY}` },
  });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

/* -------------------------------------------------------------- Geocode */

async function handleGeocode(url, ctx) {
  const q = (url.searchParams.get('q') || '').trim();
  if (q.length < 2 || q.length > 120) return json({ error: 'Query must be 2-120 characters' }, 400);
  const cache = caches.default;
  const key = new Request(url.origin + '/api/geocode?q=' + encodeURIComponent(q.toLowerCase()), { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;

  const r = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&addressdetails=0&q=' + encodeURIComponent(q), {
    headers: { 'user-agent': UA, accept: 'application/json' },
    cf: { cacheTtl: DAY, cacheEverything: true },
  });
  if (!r.ok) return json({ error: 'Geocoder is unavailable' }, 502);
  const raw = await r.json();
  const results = (Array.isArray(raw) ? raw : []).map((p) => ({
    name: String(p.display_name || '').slice(0, 160),
    lat: Number(p.lat),
    lon: Number(p.lon),
    kind: String(p.type || ''),
  })).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  const res = json({ results }, 200, { 'cache-control': `public, max-age=${DAY}` });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}
