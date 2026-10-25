/* RW Map Forge - generation pipeline (Web Worker).
 * Keeps the UI responsive: downloads elevation + OSM data, classifies terrain and builds the TMX file off the main thread. */
'use strict';
importScripts('/js/gen.js');
const G = self.RWGen;

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
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50) throw new Error('Not a PNG');
  let pos = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0, total = 0;
  const idat = [];
  while (pos + 8 <= bytes.length) {
    const len = dv.getUint32(pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    if (type === 'IHDR') { w = dv.getUint32(pos + 8); h = dv.getUint32(pos + 12); depth = bytes[pos + 16]; ctype = bytes[pos + 17]; interlace = bytes[pos + 20]; }
    else if (type === 'IDAT') { idat.push(bytes.subarray(pos + 8, pos + 8 + len)); total += len; }
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (w !== 256 || h !== 256 || depth !== 8 || interlace !== 0 || (ctype !== 2 && ctype !== 6)) throw new Error('Unsupported PNG layout');
  const all = new Uint8Array(total);
  let o = 0;
  for (const c of idat) { all.set(c, o); o += c.length; }
  const raw = await inflate(all);
  const bpp = ctype === 2 ? 3 : 4, stride = w * bpp, px = new Uint8Array(stride * h);
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
      else { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
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
  const z = G.demZoom(geo, 36), r = G.demRange(geo, z);
  const nx = r.tx1 - r.tx0 + 1, ny = r.ty1 - r.ty0 + 1;
  progress('elevation', 'Requesting ' + nx * ny + ' elevation tiles (zoom ' + z + ')', 0.03);
  const res = await fetch('/api/dem?z=' + z + '&x0=' + r.tx0 + '&x1=' + r.tx1 + '&y0=' + r.ty0 + '&y1=' + r.ty1);
  if (!res.ok) throw new Error(await errorFrom(res, 'Elevation request failed'));
  const buf = await res.arrayBuffer();
  const dv = new DataView(buf), tiles = new Map();
  let pos = 0, n = 0, missing = 0;
  for (let ty = r.ty0; ty <= r.ty1; ty++) {
    for (let tx = r.tx0; tx <= r.tx1; tx++) {
      const len = dv.getUint32(pos, true); pos += 4;
      if (len) {
        try { tiles.set(tx + ',' + ty, await decodeTile(new Uint8Array(buf, pos, len))); } catch (_) { missing++; }
        pos += len;
      } else missing++;
      n++;
      progress('elevation', 'Decoding elevation tiles ' + n + '/' + nx * ny, 0.03 + 0.17 * n / (nx * ny));
    }
  }
  if (!tiles.size) throw new Error('Could not read any elevation tile.');
  if (missing) progress('elevation', missing + ' tile(s) missing; neighbouring values will fill the gaps', 0.2);
  const elev = G.sampleDem(geo, z, (tx, ty) => tiles.get(tx + ',' + ty) || null);
  tiles.clear();
  return elev;
}

async function osmRequest(label, query) {
  progress('osm', 'Downloading ' + label + ' from OpenStreetMap (this can take a minute)', 0.25);
  const res = await fetch('/api/osm', { method: 'POST', body: query });
  if (!res.ok) throw new Error(label + ': ' + (await errorFrom(res, 'OpenStreetMap request failed')));
  const json = await res.json();
  if (json.remark) progress('osm', 'Overpass remark (' + label + '): ' + json.remark, 0.3);
  return json.elements || [];
}

async function loadOsm(geo, o) {
  const bb = geo.bbox(), parts = [];
  if (o.water) parts.push(['water', G.buildOverpassQuery(bb, { water: true, timeout: 25 })]);
  if (o.land || o.roads) parts.push(['land cover', G.buildOverpassQuery(bb, { land: o.land, roads: o.roads, timeout: 25 })]);
  let elements = [], ok = 0;
  for (const p of parts) {
    try { elements = elements.concat(await osmRequest(p[0], p[1])); ok++; }
    catch (err) { progress('osm', 'Skipped ' + p[0] + ': ' + err.message, 0.4); }
  }
  return ok ? { elements: elements } : null;
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
    if (json) { progress('osm', 'Rasterizing ' + json.elements.length + ' map features', 0.55); ras = G.rasterizeOsm(json, geo, W, H, p.osm); }
    else progress('osm', 'No OpenStreetMap data; using elevation only', 0.55);
  } else progress('osm', 'OpenStreetMap disabled', 0.55);

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
