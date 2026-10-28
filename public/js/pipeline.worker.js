/* RW Map Forge - generation pipeline (Web Worker).
 * Keeps the UI responsive: downloads elevation + OSM data, classifies terrain and builds the TMX file off the main thread. */
'use strict';
importScripts('/js/gen.js?v=urban-landcover-confidence-20261028-1', '/js/arcgis.js?v=vector-axis-normalization-20261026-1');
const G = self.RWGen;
const A = self.RWArcGIS;

const post = (type, data, transfer) => self.postMessage(Object.assign({ type: type }, data || {}), transfer || []);
const progress = (step, msg, pct) => post('progress', { step: step, msg: msg, pct: pct });

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'generate') await generate(m.params);
    else if (m.type === 'export') await exportTmx(m);
  } catch (err) {
    post('error', { message: (err && err.message) || String(err), code: err && err.code });
  }
};

/* ------------------------------------------------------------ PNG decoding */

async function inflate(u8) {
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Reads a Terrarium PNG without a canvas (canvas readback can be altered by privacy features). Returns half-meter Int16 values. */
async function decodePngElevation(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 33 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47 ||
      bytes[4] !== 0x0d || bytes[5] !== 0x0a || bytes[6] !== 0x1a || bytes[7] !== 0x0a) throw new Error('Not a complete PNG');
  let pos = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0, total = 0;
  let hasHeader = false, hasIend = false, hasIdat = false, idatClosed = false;
  const idat = [];
  while (pos + 12 <= bytes.length) {
    const len = dv.getUint32(pos);
    if (len > bytes.length - pos - 12) throw new Error('Truncated PNG chunk');
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const storedCrc = dv.getUint32(pos + 8 + len);
    const actualCrc = crc32(bytes.subarray(pos + 4, pos + 8 + len));
    if (actualCrc !== storedCrc) throw new Error('PNG chunk checksum mismatch in ' + type);
    if (!hasHeader && (type !== 'IHDR' || pos !== 8 || len !== 13)) throw new Error('PNG IHDR chunk is missing or malformed');
    if (type === 'IHDR') {
      if (hasHeader || pos !== 8 || len !== 13) throw new Error('PNG has an invalid IHDR chunk');
      w = dv.getUint32(pos + 8); h = dv.getUint32(pos + 12);
      depth = bytes[pos + 16]; ctype = bytes[pos + 17]; interlace = bytes[pos + 20];
      if (bytes[pos + 18] !== 0 || bytes[pos + 19] !== 0) throw new Error('Unsupported PNG compression or filter method');
      hasHeader = true;
    } else if (type === 'IDAT') {
      if (idatClosed) throw new Error('PNG IDAT chunks are not contiguous');
      idat.push(bytes.subarray(pos + 8, pos + 8 + len)); total += len; hasIdat = true;
    } else if (type === 'IEND') {
      if (len !== 0 || !hasIdat || pos + 12 !== bytes.length) throw new Error('PNG end marker is malformed or has trailing data');
      hasIend = true; break;
    } else if (hasIdat) {
      idatClosed = true;
    }
    pos += 12 + len;
  }
  if (!hasHeader || !hasIdat || !hasIend) throw new Error('PNG is missing a required chunk');
  if (w !== 256 || h !== 256 || depth !== 8 || interlace !== 0 || (ctype !== 2 && ctype !== 6)) throw new Error('Unsupported PNG layout');
  const all = new Uint8Array(total);
  let o = 0;
  for (const c of idat) { all.set(c, o); o += c.length; }
  const raw = await inflate(all);
  const bpp = ctype === 2 ? 3 : 4, stride = w * bpp;
  if (raw.length !== h * (stride + 1)) throw new Error('Elevation PNG decompressed to an incomplete scanline buffer');
  const px = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= bpp ? px[dst + i - bpp] : 0;
      const b = y ? px[dst - stride + i] : 0;
      const c = y && i >= bpp ? px[dst - stride + i - bpp] : 0;
      let v;
      if (ft === 0) v = x;
      else if (ft === 1) v = x + a;
      else if (ft === 2) v = x + b;
      else if (ft === 3) v = x + ((a + b) >> 1);
      else if (ft === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      else throw new Error('PNG contains an invalid scanline filter ' + ft);
      px[dst + i] = v & 255;
    }
  }
  const out = new Int16Array(65536);
  for (let i = 0; i < 65536; i++) {
    const e = px[i * bpp] * 256 + px[i * bpp + 1] + px[i * bpp + 2] / 256 - 32768;
    out[i] = Math.max(-32767, Math.min(32767, Math.round(e * 2)));
  }
  return out;
}

/** Fallback when DecompressionStream is unavailable. */
async function decodeCanvasElevation(bytes) {
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const cv = new OffscreenCanvas(256, 256), cx = cv.getContext('2d', { willReadFrequently: true });
  cx.drawImage(bmp, 0, 0);
  const d = cx.getImageData(0, 0, 256, 256).data, out = new Int16Array(65536);
  for (let i = 0; i < 65536; i++) {
    const e = d[4 * i] * 256 + d[4 * i + 1] + d[4 * i + 2] / 256 - 32768;
    out[i] = Math.max(-32767, Math.min(32767, Math.round(e * 2)));
  }
  return out;
}

const decodeTile = (bytes) =>
  typeof DecompressionStream !== 'undefined' ? decodePngElevation(bytes) : decodeCanvasElevation(bytes);

/* ---------------------------------------------------------------- Data I/O */

async function errorFrom(res, fallback) {
  try { const j = await res.json(); if (j && j.error) return j.error; } catch (_) { /* ignore */ }
  return fallback + ' (HTTP ' + res.status + ')';
}

async function loadElevation(geo) {
  // The edge worker may need to try two upstream hostnames per tile. Keep the
  // requested batch under the free-plan subrequest budget (20 tiles × 2 hosts).
  const z = G.demZoom(geo, 20), r = G.demRange(geo, z);
  const nx = r.tx1 - r.tx0 + 1, ny = r.ty1 - r.ty0 + 1;
  const expected = nx * ny;
  // Version the batch-cache key so old, unchecked DEM batches cannot be reused.
  const url = '/api/dem?v=png-crc-20261026-1&z=' + z + '&x0=' + r.tx0 + '&x1=' + r.tx1 + '&y0=' + r.ty0 + '&y1=' + r.ty1;
  let lastIssue = 'unknown elevation data error';

  // Partial batches are not valid terrain: retry them, then fail clearly instead
  // of silently spreading missing elevations into large flat-looking map areas.
  for (let attempt = 1; attempt <= 3; attempt++) {
    progress('elevation', (attempt === 1 ? 'Requesting ' : 'Retrying ') + expected +
      ' elevation tiles (zoom ' + z + ', attempt ' + attempt + '/3)', 0.03);
    let res;
    try {
      res = await fetch(url, { cache: 'no-store' });
    } catch (err) {
      lastIssue = err && err.message || String(err);
      if (attempt < 3) { await new Promise((resolve) => setTimeout(resolve, 250 * attempt)); continue; }
      break;
    }
    if (!res.ok) {
      lastIssue = await errorFrom(res, 'Elevation request failed');
      if (res.status >= 500 && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        continue;
      }
      throw new Error(lastIssue);
    }

    const present = Number(res.headers.get('x-tiles-present'));
    const total = Number(res.headers.get('x-tiles-total'));
    if (present !== expected || total !== expected) {
      lastIssue = 'provider returned ' + (Number.isFinite(present) ? present : 0) + '/' +
        (Number.isFinite(total) ? total : expected) + ' complete elevation tiles';
      if (attempt < 3) { await new Promise((resolve) => setTimeout(resolve, 250 * attempt)); continue; }
      break;
    }

    try {
      const buf = await res.arrayBuffer();
      const dv = new DataView(buf), tiles = new Map();
      let pos = 0, missing = 0;
      for (let ty = r.ty0; ty <= r.ty1; ty++) {
        for (let tx = r.tx0; tx <= r.tx1; tx++) {
          if (pos + 4 > dv.byteLength) throw new Error('Elevation batch ended before tile ' + tx + ',' + ty);
          const len = dv.getUint32(pos, true); pos += 4;
          if (!len || pos + len > dv.byteLength) throw new Error('Elevation tile ' + tx + ',' + ty + ' is missing or truncated');
          let decoded;
          try {
            decoded = await decodeTile(new Uint8Array(buf, pos, len));
          } catch (err) {
            throw new Error('Elevation tile ' + tx + ',' + ty + ' is corrupt: ' + (err && err.message || String(err)));
          }
          if (!(decoded instanceof Int16Array) || decoded.length !== 65536) {
            throw new Error('Elevation tile ' + tx + ',' + ty + ' decoded to an invalid size');
          }
          tiles.set(tx + ',' + ty, decoded);
          pos += len;
          progress('elevation', 'Decoding elevation tiles ' + tiles.size + '/' + expected, 0.03 + 0.17 * tiles.size / expected);
        }
      }
      if (pos !== dv.byteLength) throw new Error('Elevation batch has unexpected trailing bytes');
      if (missing) throw new Error(missing + ' missing elevation tile(s)');
      const elev = G.sampleDem(geo, z, (tx, ty) => tiles.get(tx + ',' + ty) || null);
      if (elev.some((v) => !Number.isFinite(v))) throw new Error('Elevation sampling produced invalid values');
      tiles.clear();
      return elev;
    } catch (err) {
      lastIssue = err && err.message || String(err);
      if (attempt < 3) { await new Promise((resolve) => setTimeout(resolve, 250 * attempt)); continue; }
    }
  }
  throw new Error('Elevation data remained incomplete after 3 attempts; no partial map was generated. ' + lastIssue + '. Please try generating again.');
}

async function osmRequest(label, query) {
  progress('osm', 'Downloading ' + label + ' from OpenStreetMap (this can take a minute)', 0.25);
  const res = await fetch('/api/osm', { method: 'POST', body: query });
  if (!res.ok) throw new Error(label + ': ' + (await errorFrom(res, 'OpenStreetMap request failed')));
  const json = await res.json();
  if (json.remark) progress('osm', 'Overpass remark (' + label + '): ' + json.remark, 0.3);
  return json.elements || [];
}

async function fetchArcgisSource(source, bbox) {
  const res = await fetch('/api/terrain-features', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bbox: bbox, source: source }),
  });
  if (!res.ok) throw new Error(await errorFrom(res, 'Terrain data request failed'));
  const data = await res.json();
  if (data && data.error) throw new Error(typeof data.error === 'string' ? data.error : (data.error.message || 'Terrain data API error'));
  if (!data || !Array.isArray(data.features)) throw new Error('Terrain data source did not return a feature collection');
  return {
    features: data.features,
    cacheStatus: res.headers.get('x-terrain-cache') || 'UNKNOWN',
    dataSource: res.headers.get('x-terrain-source') || 'unknown source',
  };
}

function terrainCellsForBounds(bbox, maxCells = 16) {
  const round = (v) => Number(v.toFixed(6));
  const make = (step) => {
    const minX = Math.floor(bbox.w / step);
    const maxX = Math.ceil(bbox.e / step) - 1;
    const minY = Math.floor(bbox.s / step);
    const maxY = Math.ceil(bbox.n / step) - 1;
    const cells = [];
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        cells.push({
          s: round(y * step),
          w: round(x * step),
          n: round((y + 1) * step),
          e: round((x + 1) * step),
        });
      }
    }
    return cells;
  };

  let step = 0.25;
  let cells = make(step);
  while (cells.length > maxCells && step < 8) {
    step *= 2;
    cells = make(step);
  }
  if (cells.length > maxCells) throw new Error('Selected map covers too many terrain cells; reduce map dimensions or tile size.');
  return { cells: cells, step: step };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const count = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: count }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

function dedupeArcgisFeatures(features) {
  const seen = new Set();
  return features.filter((feature) => {
    const attrs = feature && (feature.attributes || feature.properties) || {};
    const idEntry = Object.entries(attrs).find(([key, value]) =>
      value != null && /^(objectid|fid|oid)(?:_\d+)?$/i.test(key));
    const key = idEntry
      ? 'id:' + idEntry[0].toLowerCase() + ':' + String(idEntry[1])
      : 'geom:' + JSON.stringify(feature && feature.geometry || {});
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function loadLegacyOsm(geo, o) {
  const bb = geo.bbox();
  const grid = terrainCellsForBounds(bb);
  let elements = [], successes = 0;
  const sources = [];
  if (o.water) {
    sources.push({ source: 'water', label: 'water bodies', kind: 'water' });
    sources.push({ source: 'rivers', label: 'major rivers', kind: 'rivers' });
  }
  if (o.land) sources.push({ source: 'land', label: 'land cover', kind: 'land' });

  const settled = await Promise.all(sources.map(async (s) => {
    try {
      progress('osm', 'Loading ' + s.label + ' from the persistent terrain grid (' +
        grid.cells.length + ' cell(s))', 0.25);
      const cellResults = await mapLimit(grid.cells, 4, async (cell) => {
        try {
          return { cell: cell, result: await fetchArcgisSource(s.source, cell), error: null };
        } catch (err) {
          return { cell: cell, result: null, error: err.message || String(err) };
        }
      });

      const okay = cellResults.filter((x) => x.result);
      const failed = cellResults.filter((x) => x.error);
      if (!okay.length) {
        throw new Error(failed.map((x) => x.error).join(' | ') || 'No terrain cells could be loaded');
      }

      const rawFeatures = dedupeArcgisFeatures(okay.flatMap((x) => x.result.features));
      const converted = [];
      for (let i = 0; i < rawFeatures.length; i++) {
        converted.push(...A.featureToElements(rawFeatures[i], s.kind, bb, (i + 1) * 100000));
      }

      const statuses = okay.map((x) => x.result.cacheStatus);
      const cacheLabel = statuses.every((v) => v === 'HIT') ? 'R2 cache hit'
        : statuses.some((v) => v === 'MISS') ? 'fetched and saved to R2'
        : statuses.some((v) => v === 'EDGE-HIT') ? 'edge cache hit'
        : 'cache ' + (statuses[0] || 'UNKNOWN');
      let msg = 'Loaded ' + converted.length + ' ' + s.label + ' feature(s) from ' +
        rawFeatures.length + ' raw record(s); ' + cacheLabel;
      if (failed.length) msg += '; ' + failed.length + ' cell(s) unavailable';
      progress('osm', msg, 0.42);
      if (failed.length) progress('osm', 'Partial terrain data for ' + s.label + ': ' +
        failed.map((x) => x.error).join(' | '), 0.44);
      return { success: true, label: s.label, elements: converted };
    } catch (err) {
      return { success: false, label: s.label, error: err.message || String(err) };
    }
  }));
  for (const item of settled) {
    if (item.success) {
      elements = elements.concat(item.elements);
      successes++;
    } else {
      progress('osm', 'Skipped ' + item.label + ': ' + item.error, 0.44);
    }
  }

  // The optional roads overlay remains a separate Overpass request.
  if (o.roads) {
    try {
      const roadQuery = G.buildOverpassQuery(bb, { water: false, land: false, roads: true, timeout: 20 });
      if (roadQuery) {
        elements = elements.concat(await osmRequest('major roads', roadQuery));
        successes++;
      }
    } catch (err) {
      progress('osm', 'Skipped major roads: ' + err.message, 0.48);
    }
  }
  return successes ? { elements: elements } : null;
}

/* ------------------------------------------- preloaded R2 terrain datasets */
const HYDRO_TILE_DEG = 4;
const ROAD_TILE_DEG = 10;
const LAND_TILE_DEG = 10;
const LAND_TILE_RES = 0.025;
const LAND_TILE_SIDE = 400;
const LAND_TILE_BYTES = LAND_TILE_SIDE * LAND_TILE_SIDE;
const hydroTilePromises = new Map();
const landTilePromises = new Map();

function normalizeLongitude(lon) {
  return ((lon + 180) % 360 + 360) % 360 - 180;
}

function tileIndicesForBounds(bbox, degrees) {
  const nx = Math.round(360 / degrees);
  const ny = Math.round(180 / degrees);
  const firstX = Math.floor((bbox.w + 180) / degrees);
  const lastX = Math.floor((bbox.e + 180 - 1e-9) / degrees);
  const firstY = Math.max(0, Math.floor((bbox.s + 90) / degrees));
  const lastY = Math.min(ny - 1, Math.floor((bbox.n + 90 - 1e-9) / degrees));
  const xs = new Set();
  for (let i = firstX; i <= lastX; i++) xs.add(((i % nx) + nx) % nx);
  const tiles = [];
  for (let y = firstY; y <= lastY; y++) for (const x of xs) tiles.push({ x: x, y: y });
  return tiles;
}

async function gunzipBytes(bytes) {
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser does not support gzip decompression');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function fetchHydroTile(source, x, y) {
  const cacheKey = source + '/' + x + '/' + y;
  if (!hydroTilePromises.has(cacheKey)) {
    const promise = (async () => {
      const res = await fetch('/api/hydro-tile?source=' + encodeURIComponent(source) + '&x=' + x + '&y=' + y);
      if (!res.ok) throw new Error(await errorFrom(res, 'Self-hosted ' + source + ' tile request failed'));
      if (res.headers.get('x-global-tile-empty') === '1') return [];
      const raw = await gunzipBytes(new Uint8Array(await res.arrayBuffer()));
      const collection = JSON.parse(new TextDecoder().decode(raw));
      if (!collection || !Array.isArray(collection.features)) throw new Error('Invalid self-hosted vector tile for ' + source);
      return collection.features;
    })();
    hydroTilePromises.set(cacheKey, promise);
    promise.catch(() => hydroTilePromises.delete(cacheKey));
  }
  return hydroTilePromises.get(cacheKey);
}

function featureDedupKey(feature) {
  const props = feature && (feature.properties || feature.attributes) || {};
  const entry = Object.entries(props).find(([key, value]) =>
    value != null && /^(hyriv_id|hylak_id|ne_id|objectid|fid|oid)(?:_\d+)?$/i.test(key));
  // Include geometry: source features are clipped at 2° tile edges, so fragments
  // sharing an original source ID must not erase each other at tile boundaries.
  return (entry ? entry[0].toLowerCase() + ':' + String(entry[1]) : 'no-id') +
    ':' + JSON.stringify(feature && feature.geometry || {});
}

function dedupeGlobalFeatures(features) {
  const seen = new Set();
  return features.filter((feature) => {
    const key = featureDedupKey(feature);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchSelfHostedFeatures(source, bbox) {
  const degrees = source === 'roads' ? ROAD_TILE_DEG : HYDRO_TILE_DEG;
  const tiles = tileIndicesForBounds(bbox, degrees);
  const fetched = await mapLimit(tiles, 4, async (tile) => ({
    tile: tile,
    features: await fetchHydroTile(source, tile.x, tile.y),
  }));
  return {
    features: dedupeGlobalFeatures(fetched.flatMap((r) => r.features)),
    tiles: tiles.length,
    tileKeys: tiles.map((tile) => tile.x + '/' + tile.y),
  };
}

async function fetchLandCoverTile(x, y) {
  const key = x + '/' + y;
  if (!landTilePromises.has(key)) {
    const promise = (async () => {
      const res = await fetch('/api/landcover-tile?x=' + x + '&y=' + y);
      if (!res.ok) throw new Error(await errorFrom(res, 'Self-hosted land-cover tile request failed'));
      const bytes = await gunzipBytes(new Uint8Array(await res.arrayBuffer()));
      if (bytes.length !== LAND_TILE_BYTES) {
        throw new Error('Invalid land-cover tile size at ' + key + ': expected ' + LAND_TILE_BYTES + ', got ' + bytes.length);
      }
      return bytes;
    })();
    landTilePromises.set(key, promise);
    promise.catch(() => landTilePromises.delete(key));
  }
  return landTilePromises.get(key);
}

function mercatorCellToGeo(geo, x, y) {
  const earth = 6378137;
  const mx = geo.x0 + (x + 0.5) * geo.k;
  const my = geo.yTop - (y + 0.5) * geo.k;
  const lat = (2 * Math.atan(Math.exp(my / earth)) - Math.PI / 2) * 180 / Math.PI;
  return { lat: lat, lon: normalizeLongitude(mx / earth * 180 / Math.PI) };
}

async function sampleLandCover(geo, W, H) {
  const bbox = geo.bbox();
  // Include adjacent 0.025° source cells so the 3×3 categorical filter remains valid
  // even when a map touches a 10° R2 tile edge.
  const expandedBounds = {
    s: Math.max(-90, bbox.s - LAND_TILE_RES),
    w: bbox.w - LAND_TILE_RES,
    n: Math.min(90, bbox.n + LAND_TILE_RES),
    e: bbox.e + LAND_TILE_RES,
  };
  const tileRefs = tileIndicesForBounds(expandedBounds, LAND_TILE_DEG);
  const entries = await Promise.all(tileRefs.map(async (tile) => ({
    key: tile.x + '/' + tile.y,
    data: await fetchLandCoverTile(tile.x, tile.y),
  })));
  const tiles = new Map(entries.map((entry) => [entry.key, entry.data]));
  const mask = new Uint8Array(W * H);
  const totalCols = 360 / LAND_TILE_RES;
  const totalRows = 180 / LAND_TILE_RES;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const geoPos = mercatorCellToGeo(geo, x, y);
      const lon = geoPos.lon, lat = geoPos.lat;
      if (lat < -90 || lat > 90) continue;
      const centerCol = Math.min(totalCols - 1, Math.max(0, Math.floor((normalizeLongitude(lon) + 180) / LAND_TILE_RES)));
      const centerRow = Math.min(totalRows - 1, Math.max(0, Math.floor((90 - lat) / LAND_TILE_RES)));
      const neighborhood = [];
      for (let dy = -1; dy <= 1; dy++) {
        const sourceRow = Math.min(totalRows - 1, Math.max(0, centerRow + dy));
        const tileY = 17 - Math.floor(sourceRow / LAND_TILE_SIDE);
        const localRow = sourceRow % LAND_TILE_SIDE;
        for (let dx = -1; dx <= 1; dx++) {
          const sourceCol = ((centerCol + dx + totalCols) % totalCols);
          const tileX = Math.floor(sourceCol / LAND_TILE_SIDE);
          const data = tiles.get(tileX + '/' + tileY);
          neighborhood.push(data ? data[localRow * LAND_TILE_SIDE + (sourceCol % LAND_TILE_SIDE)] : 0);
        }
      }
      // The imported MODIS raster is intentionally coarse (0.025° per cell).
      // Use a 3×3 mode to suppress isolated square land-cover labels before they
      // override the elevation-derived terrain classification.
      mask[y * W + x] = G.landCoverMode(neighborhood);
    }
  }
  return mask;
}

async function loadSelfHostedOsm(geo, o) {
  const bbox = geo.bbox();
  progress('osm', 'Clipping bounds: lat ' + bbox.s.toFixed(5) + '..' + bbox.n.toFixed(5) +
    ', lon ' + bbox.w.toFixed(5) + '..' + bbox.e.toFixed(5), 0.245);
  let elements = [], successes = 0, landCoverMask = null;
  const sources = [];
  if (o.water) {
    sources.push({ source: 'water', label: 'lakes and reservoirs', kind: 'water' });
    sources.push({ source: 'rivers', label: 'major rivers', kind: 'rivers' });
  }
  if (o.roads) sources.push({ source: 'roads', label: 'major roads', kind: 'roads' });

  const settled = await Promise.all(sources.map(async (s) => {
    try {
      progress('osm', 'Loading ' + s.label + ' from locally hosted R2 tiles', 0.25);
      const result = await fetchSelfHostedFeatures(s.source, bbox);
      const converted = [];
      const conversionStats = { axisSwapped: 0 };
      for (let i = 0; i < result.features.length; i++) {
        converted.push(...A.featureToElements(
          result.features[i], s.kind, bbox, (i + 1) * 100000, conversionStats,
        ));
      }
      if (conversionStats.axisSwapped) {
        progress('osm', 'Normalized coordinate axes in ' + conversionStats.axisSwapped +
          ' ' + s.label + ' source geometry item(s)', 0.41);
      }
      progress('osm', 'Loaded ' + converted.length + ' ' + s.label + ' features from R2 (' +
        result.tiles + ' tile(s) [' + result.tileKeys.join(', ') + '], ' +
        result.features.length + ' source records)', 0.42);
      if (result.features.length && !converted.length) {
        progress('osm', 'No ' + s.label + ' geometries intersected the clipping bounds; source records cover the larger R2 tile, not only this map.', 0.43);
      }
      return { success: true, label: s.label, elements: converted };
    } catch (err) {
      return { success: false, label: s.label, error: err.message || String(err) };
    }
  }));

  for (const item of settled) {
    if (item.success) {
      elements = elements.concat(item.elements);
      successes++;
    } else {
      progress('osm', 'Skipped local ' + item.label + ': ' + item.error, 0.44);
    }
  }

  if (o.land) {
    try {
      progress('osm', 'Loading global land cover from local R2 tiles', 0.45);
      landCoverMask = await sampleLandCover(geo, geo.W, geo.H);
      progress('osm', 'Loaded global MODIS land-cover grid from R2 (3×3 smoothing)', 0.49);
      successes++;
    } catch (err) {
      progress('osm', 'Skipped local land cover: ' + (err.message || String(err)), 0.5);
    }
  }

  return successes ? { elements: elements, landCoverMask: landCoverMask } : null;
}

async function loadOsm(geo, o) {
  // Keep the existing remote path until the first complete global import finishes.
  // Once the manifest is ready, all water, rivers, roads and land-cover reads stay in R2.
  try {
    const statusRes = await fetch('/api/terrain-status');
    const status = await statusRes.json();
    if (status && status.ready === true) return await loadSelfHostedOsm(geo, o);
    progress('osm', 'Global R2 dataset is not ready yet; using the existing online fallback', 0.24);
  } catch (_) {
    progress('osm', 'Global R2 dataset status unavailable; using the existing online fallback', 0.24);
  }
  return await loadLegacyOsm(geo, o);
}


/* ---------------------------------------------------------------- Generate */

async function generate(p) {
  const W = p.W, H = p.H, mpt = p.mpt;
  const geo = G.makeGeo(p.lat, p.lon, W, H, mpt);
  const elev = await loadElevation(geo);
  let emax = -1e9, emin = 1e9;
  for (let i = 0; i < elev.length; i++) { if (elev[i] > emax) emax = elev[i]; if (elev[i] < emin) emin = elev[i]; }
  if (emax <= p.seaLevel) {
    const err = new Error('The selected area is entirely sea (highest point ' + Math.round(emax) + ' m, deepest ' + Math.round(emin) +
      ' m). Pick a spot on land and check that latitude comes first and longitude second.');
    err.code = 'ocean';
    throw err;
  }
  progress('elevation', 'Elevation range ' + Math.round(emin) + ' to ' + Math.round(emax) + ' m', 0.22);

  let ras = { water: null, land: null, road: null };
  if (p.osm.water || p.osm.land || p.osm.roads) {
    const json = await loadOsm(geo, p.osm);
    if (json) {
      progress('osm', 'Rasterizing ' + json.elements.length + ' map features', 0.55);
      ras = G.rasterizeOsm({ elements: json.elements }, geo, W, H, p.osm);
      if (json.landCoverMask) {
        for (let i = 0; i < json.landCoverMask.length; i++) {
          if (json.landCoverMask[i] !== 0) ras.land[i] = json.landCoverMask[i];
        }
      }
    } else progress('osm', 'No external map-feature data; using elevation only', 0.55);
  } else progress('osm', 'External map-feature data disabled', 0.55);

  progress('terrain', 'Classifying terrain', 0.65);
  const r = G.classify({ W: W, H: H, mpt: mpt, lat: p.lat, elev: elev, water: ras.water, land: ras.land, road: ras.road }, p.terrain);
  const st = { W: W, H: H, cls: r.cls, treeCand: r.treeCand, spawns: [], pools: [], seed: p.seed };
  progress('terrain', 'Placing vegetation', 0.8);
  G.placeTrees(st, p.treeDensity, p.seed);
  if (p.autoPlace) {
    progress('players', 'Placing players and resources', 0.88);
    st.spawns = G.autoSpawns(st, p.players, p.seed);
    st.spawns.forEach((s) => { G.flatten(st, s.x, s.y, 5); G.clearTreesAround(st, s.x, s.y, 7); });
    st.pools = G.autoPools(st, st.spawns, p.neutral, p.seed);
  }
  progress('done', 'Done', 1);
  post('result', {
    W: W, H: H, cls: st.cls, shade: r.shade, treeCand: r.treeCand, trees: st.trees, elev: elev,
    spawns: st.spawns, pools: st.pools, thresholds: r.thresholds, seed: p.seed,
  }, [st.cls.buffer, r.shade.buffer, r.treeCand.buffer, st.trees.buffer, elev.buffer]);
}

/* ------------------------------------------------------------------ Export */

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (u8) => { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const adler32 = (u8) => { let a = 1, b = 0; for (let i = 0; i < u8.length; i++) { a = (a + u8[i]) % 65521; b = (b + a) % 65521; } return ((b << 16) | a) >>> 0; };

/** Valid gzip/zlib container using "stored" deflate blocks; used only when CompressionStream is unavailable. */
function storedContainer(u8, fmt) {
  const blocks = Math.max(1, Math.ceil(u8.length / 65535));
  const head = fmt === 'zlib' ? 2 : 10, tail = fmt === 'zlib' ? 4 : 8;
  const out = new Uint8Array(head + u8.length + blocks * 5 + tail), dv = new DataView(out.buffer);
  let p = 0;
  if (fmt === 'zlib') { out[p++] = 0x78; out[p++] = 0x01; }
  else { out.set([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255], 0); p = 10; }
  for (let i = 0; i < blocks; i++) {
    const chunk = u8.subarray(i * 65535, Math.min(u8.length, (i + 1) * 65535));
    out[p++] = i === blocks - 1 ? 1 : 0;
    dv.setUint16(p, chunk.length, true); dv.setUint16(p + 2, ~chunk.length & 0xffff, true); p += 4;
    out.set(chunk, p); p += chunk.length;
  }
  if (fmt === 'zlib') dv.setUint32(p, adler32(u8), false);
  else { dv.setUint32(p, crc32(u8), true); dv.setUint32(p + 4, u8.length >>> 0, true); }
  return out;
}

async function pack(u8, fmt) {
  let bytes;
  if (typeof CompressionStream !== 'undefined') {
    const cs = new CompressionStream(fmt === 'zlib' ? 'deflate' : 'gzip');
    bytes = new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(cs)).arrayBuffer());
  } else bytes = storedContainer(u8, fmt);
  return G.bytesToB64(bytes);
}

async function exportTmx(m) {
  const s = m.state, reg = G.makeReg();
  s.regIds.forEach((id) => reg.code(id, 0));
  const st = { W: s.W, H: s.H, cls: s.cls, ground: s.ground, trees: s.trees, spawns: s.spawns, pools: s.pools, reg: reg };
  const out = await G.buildTmx(st, m.options, m.catalog, pack);
  const bytes = new TextEncoder().encode(out.xml);
  post('exported', { bytes: bytes.buffer, trees: out.trees, tilesets: out.tilesets }, [bytes.buffer]);
}
