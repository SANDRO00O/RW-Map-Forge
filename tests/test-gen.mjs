import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
// gen.js is a classic browser script (UMD); evaluate it in a sandbox exposing a CommonJS-style module object
const mod = { exports: {} };
vm.runInNewContext(readFileSync(new URL('../public/js/gen.js', import.meta.url), 'utf8'), { module: mod, Buffer, console });
const G = mod.exports;

// Every water cell uses the normal Water tileset; no depth-based variants are generated.
assert.deepEqual(JSON.parse(JSON.stringify(G.BASE_SETS.slice(0, 3))), [
  ['water', [0]], ['water', [0]], ['water', [0]],
]);
for (const outside of [G.C.SAND, G.C.GRASS, G.C.MOUNTAIN]) {
  assert.ok(G.RIM_DEF.some(([from, to]) => from === outside && to === G.C.WATER),
    'coast transitions should lead directly into regular Water');
}
{
  const width = 25, height = 25;
  const elev = new Float32Array(width * height).fill(100);
  const water = new Uint8Array(width * height);
  for (let y = 2; y <= 22; y++) {
    for (let x = 2; x <= 22; x++) water[y * width + x] = 1;
  }
  const result = G.classify(
    { W: width, H: height, mpt: 100, lat: 0, elev, water },
    { seaLevel: 0, smooth: 0, mountPct: 0, stonePct: 0, base: 'grass', beach: false },
  );
  const waterClasses = Array.from(result.cls).filter(cls =>
    cls === G.C.DEEP || cls === G.C.WATER || cls === G.C.SHALLOW);
  assert.equal(waterClasses.length, 21 * 21, 'all water area cells should be classified as water');
  assert.ok(waterClasses.every(cls => cls === G.C.WATER),
    'no cell should be classified as shallow or deep water');
}


// Negative-elevation sea must survive coastline cleanup even when the surrounding land is Dirt.
{
  const width = 24, height = 16;
  const elev = new Float32Array(width * height).fill(120);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < 9; x++) elev[y * width + x] = -12;
  }
  const classification = G.classify({
    W: width, H: height, mpt: 200, lat: 54, elev,
  }, {
    seaLevel: 0, smooth: 0, mountPct: 0, stonePct: 0,
    base: 'dirt', beach: false,
  });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < 9; x++) {
      assert.equal(classification.cls[y * width + x], G.C.WATER,
        'negative-elevation sea cells must remain Water after terrain finalization');
    }
    assert.equal(classification.cls[y * width + 9], G.C.SAND,
      'the incompatible Dirt coast should become Sand, not convert sea to Dirt');
  }
}

// Sea detection uses raw DEM heights, not smoothed heights.
{
  const width = 16, height = 10;
  const elev = new Float32Array(width * height).fill(80);
  const waterMask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < 4; x++) {
      elev[y * width + x] = -2;
      waterMask[y * width + x] = 0;
    }
    for (let x = 4; x < width; x++) waterMask[y * width + x] = 1;
  }
  const result = G.classify({
    W: width, H: height, mpt: 100, lat: 54, elev,
  }, {
    seaLevel: 0, smooth: 3, mountPct: 0, stonePct: 0,
    base: 'dirt', beach: false,
  });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < 4; x++) {
      assert.equal(result.cls[y * width + x], G.C.WATER,
        'smoothing must not erase shallow negative-elevation sea');
      assert.equal(result.waterMask[y * width + x], 1,
        'the source water mask must agree with the final sea classification');
    }
  }

  // Player-base flattening must not turn sea into buildable land.
  const st = {
    W: width, H: height, cls: result.cls, waterMask: result.waterMask,
    trees: new Uint8Array(width * height),
  };
  G.flatten(st, 3, 5, 5);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < 4; x++) {
      assert.equal(st.cls[y * width + x], G.C.WATER,
        'flattening a player base must never convert masked sea to Dirt/Grass');
    }
  }
}

// A global land polygon mask must classify ocean even when DEM heights are positive.
{
  const width = 12, height = 8;
  const elev = new Float32Array(width * height).fill(45);
  const landMask = new Uint8Array(width * height).fill(1);
  for (let y = 0; y < height; y++) for (let x = 0; x < 5; x++) landMask[y * width + x] = 0;
  const result = G.classify({
    W: width, H: height, mpt: 200, lat: 54, elev,
    landMask, landMaskAvailable: true,
  }, {
    seaLevel: -500, smooth: 2, mountPct: 0, stonePct: 0,
    base: 'dirt', beach: false,
  });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < 5; x++) assert.equal(result.cls[y * width + x], G.C.WATER,
      'the coastline mask must recover ocean omitted by imperfect/interpolated DEM values');
    for (let x = 9; x < width; x++) assert.notEqual(result.cls[y * width + x], G.C.WATER,
      'the global mask must preserve positive-elevation land');
  }
}

// Coarse categorical land-cover samples should not preserve isolated one-cell noise.
assert.equal(G.landCoverMode([5, 5, 5, 5, 2, 5, 5, 5, 5]), 5,
  'an isolated barren cell should follow the surrounding land-cover majority');
assert.equal(G.landCoverMode([1, 1, 1, 1, 7, 1, 1, 1, 1]), 1,
  'an isolated coarse water label should not survive the source-cell mode filter');
assert.equal(G.landCoverMode(new Uint8Array(9)), 0,
  'all no-data source cells should remain no-data');
assert.equal(G.landCoverMode([4, 4, 4, 4, 4, 4, 1, 1, 1]), 0,
  'a mixed coarse urban neighborhood must not force a large dirt block');
assert.equal(G.landCoverMode(new Uint8Array(9).fill(4)), 4,
  'a consistently urban 3×3 neighborhood may still become dirt when enabled');
assert.equal(G.landCoverMode([2, 2, 2, 2, 2, 1, 1, 1, 1]), 0,
  'weak land-cover majorities should defer to elevation-derived terrain');

// MODIS water is coarse (~2.8 km per cell at the equator) and must not override
// positive elevation; accurate water geometry is supplied separately.
{
  const width = 9, height = 9;
  const classification = G.classify({
    W: width,
    H: height,
    mpt: 100,
    lat: 0,
    elev: new Float32Array(width * height).fill(100),
    land: new Uint8Array(width * height).fill(7),
  }, { seaLevel: 0, smooth: 0, mountPct: 0, stonePct: 0, base: 'grass', beach: false });
  assert.ok(Array.from(classification.cls).every(cls => cls !== G.C.SHALLOW),
    'coarse MODIS water labels must not create square water patches on positive-elevation land');
  const vectorWater = new Uint8Array(width * height);
  for (let y = 1; y <= 7; y++) for (let x = 1; x <= 7; x++) {
    vectorWater[y * width + x] = 1;
  }
  const withVectorWater = G.classify({
    W: width, H: height, mpt: 100, lat: 0,
    elev: new Float32Array(width * height).fill(100),
    water: vectorWater,
  }, { seaLevel: 0, smooth: 0, mountPct: 0, stonePct: 0, base: 'grass', beach: false });
  assert.equal(withVectorWater.cls[4 * width + 4], G.C.WATER,
    'a real multi-cell water geometry should use regular Water');
}
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const cat = JSON.parse(fs.readFileSync(new URL('../public/catalog.json', import.meta.url), 'utf8'));
const W = 140, H = 110, mpt = 30;
// synthetic terrain: sea on the left, two hills, a lake, river
const elev = new Float32Array(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const sea = -20 + (x - 22) * 1.2;
  const h1 = 3900 * Math.exp(-(((x - 95) ** 2) + ((y - 40) ** 2)) / 300);
  const h2 = 300 * Math.exp(-(((x - 60) ** 2) + ((y - 85) ** 2)) / 120);
  elev[y * W + x] = Math.max(sea, 5 + h1 + h2 + 8 * Math.sin(x / 7) * Math.cos(y / 9) + 20);
  if (x < 22) elev[y * W + x] = -50;
}
// OSM-like inputs: a lake and a river and forest
const water = new Uint8Array(W * H), land = new Uint8Array(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  if ((x - 55) ** 2 + (y - 30) ** 2 < 100) water[y * W + x] = 1;
  if (Math.abs(x - (70 + 8 * Math.sin(y / 10))) < 1.2 && y > 50) water[y * W + x] = 1;
  if (x > 30 && x < 50 && y > 60 && y < 100) land[y * W + x] = 1;
}
const r = G.classify({ W, H, mpt, lat: 46.5, elev, water, land }, { seed: 3 });
const cls = r.cls;
console.log('stats', G.stats(cls).map(v => (v * 100).toFixed(1)).join(' '));
console.log('thresholds', r.thresholds);
// ASCII dump (every 2nd col)
const ch = '~=-:.,sMS'; // deep water shallow sand dirt grass stone mountain snow
const sym = ['#', '=', '-', 's', 'd', ',', 'r', 'M', 'S'];
let s = '';
for (let y = 0; y < H; y += 2) { for (let x = 0; x < W; x++) s += sym[cls[y * W + x]]; s += '\n'; }
fs.writeFileSync('/tmp/ascii.txt', s);

// validity: no violations remain
let viol = 0, missing = 0;
const NC = G.NCLS;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = y * W + x, c = cls[i];
  const o = (dx, dy) => { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) return false; const n = cls[yy * W + xx]; return n !== c && G.RIM[n * NC + c] != null; };
  if ((o(0, -1) && o(0, 1)) || (o(-1, 0) && o(1, 0))) viol++;
  // adjacent pairs with no rim in either direction
  for (const [dx, dy] of [[1, 0], [0, 1]]) { const xx = x + dx, yy = y + dy; if (xx >= W || yy >= H) continue; const n = cls[yy * W + xx]; if (n !== c && G.RIM[n * NC + c] == null && G.RIM[c * NC + n] == null) missing++; }
}
console.log('violations', viol, 'pairs-without-rim', missing);

const reg = G.makeReg();
const st = { W, H, cls, treeCand: r.treeCand, reg, spawns: [], pools: [] };
G.placeTrees(st, 0.45, 3);
st.spawns = G.autoSpawns(st, 4, 3);
st.spawns.forEach(sp => G.flatten(st, sp.x, sp.y, 5));
st.spawns.forEach(sp => G.clearTreesAround(st, sp.x, sp.y, 7));
st.pools = G.autoPools(st, st.spawns, 6, 3);
st.ground = G.autotile(st.cls, W, H, reg, 3);
console.log('spawns', JSON.stringify(st.spawns), 'pools', st.pools.length, 'sets used', reg.ids.length);
// verify every ground code refers to valid tile ids
let badTile = 0;
for (let i = 0; i < W * H; i++) { const v = st.ground[i], id = reg.ids[(v >>> 12) - 1], loc = v & 4095; if (loc >= cat[id].count) badTile++; }
console.log('invalid tile idx', badTile);
// --- new checks: only real-tsx sets, 21-tile layout for rims, no deep/stone, every adjacency supported
let unsup = 0, forbidden = 0;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const c = cls[y * W + x]; if (c === G.C.DEEP || c === G.C.STONE) forbidden++;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
    if (!G.supported(c, cls[yy * W + xx])) unsup++;
  }
}
console.log('unsupported adjacencies', unsup, '| forbidden classes (deep/stone)', forbidden);
let noTsx = 0, badLayout = 0;
reg.ids.forEach(id => { const e = cat[id]; if (!e.tsx) { noTsx++; console.log('NO TSX:', id); } });
G.RIM_DEF.forEach(r => { const e = cat[r[2]]; if (!e || !e.tsx || e.count !== 21 || e.cols !== 3) { badLayout++; console.log('BAD RIM SET', r[2]); } });
const names = {}; let dup = 0; reg.ids.forEach(id => { const n = cat[id].name; if (names[n]) { dup++; console.log('(note) duplicate original name, harmless in external mode:', n); } names[n] = 1; });
console.log('sets without tsx', noTsx, '| bad rim layouts', badLayout, '| duplicate names', dup);
console.log('classes present:', G.stats(cls).map((v, i) => v > 0 ? G.CLS_NAMES[i] + ' ' + (v * 100).toFixed(0) + '%' : '').filter(Boolean).join(' · '));

const pack = async (u8, fmt) => (fmt === 'zlib' ? zlib.deflateSync(u8) : zlib.gzipSync(u8)).toString('base64');
(async () => {
  for (const fmt of ['gzip', 'zlib', 'csv']) {
    const out = await G.buildTmx(st, { fmt, tsMode: 'external', extPrefix: '../../steamapps/common/Rusted Warfare/mods/maps/', builders: true, mapInfo: false }, cat, pack);
    fs.writeFileSync('/tmp/test_' + fmt + '.tmx', out.xml);
    console.log(fmt, 'bytes', out.xml.length, 'trees', out.trees, 'tilesets', out.tilesets);
  }
  const ext = await G.buildTmx(st, { fmt: 'gzip', tsMode: 'external', extPrefix: '../../assets/tilesets/', builders: false }, cat, pack);
  fs.writeFileSync('/tmp/test_ext.tmx', ext.xml);
  const emb = await G.buildTmx(st, { fmt: 'gzip', tsMode: 'embed', builders: true, mapInfo: true }, cat, pack);
  fs.writeFileSync('/tmp/test_embed.tmx', emb.xml);
  // OSM rasterization test
  const geo = G.makeGeo(46.5, 8.0, W, H, mpt);
  const bb = geo.bbox();
  const mid = geo.toCell(46.5, 8.0);
  console.log('bbox', bb, 'center cell', mid.map(v => v.toFixed(2)));
  const ll = (cx, cy) => { const m = [geo.x0 + cx * geo.k, geo.yTop - cy * geo.k]; const p = G.unmerc(m[0], m[1]); return { lat: p[0], lon: p[1] }; };
  const poly = [[20, 20], [60, 20], [60, 50], [20, 50], [20, 20]].map(p => ll(p[0], p[1]));
  const hole = [[30, 30], [40, 30], [40, 40], [30, 40], [30, 30]].map(p => ll(p[0], p[1]));
  const rel = { type: 'relation', tags: { natural: 'water' }, members: [{ type: 'way', role: 'outer', geometry: poly.slice(0, 3) }, { type: 'way', role: 'outer', geometry: poly.slice(2) }, { type: 'way', role: 'inner', geometry: hole }] };
  const wayRiver = { type: 'way', tags: { waterway: 'river', width: '30' }, geometry: [ll(5, 70), ll(100, 80)] };
  const wood = { type: 'way', tags: { natural: 'wood' }, geometry: [[80, 70], [120, 70], [120, 100], [80, 100], [80, 70]].map(p => ll(p[0], p[1])) };
  const landMaskPoly = {
    type: 'way', tags: { rw_map_forge_landmask: 'true' },
    geometry: [[10, 10], [30, 10], [30, 30], [10, 30], [10, 10]].map(p => ll(p[0], p[1])),
  };
  const ras = G.rasterizeOsm({ elements: [rel, wayRiver, wood, landMaskPoly] }, geo, W, H, { water: true, land: true, roads: false });
  let wc = 0, lc = 0; for (let i = 0; i < W * H; i++) { wc += ras.water[i]; lc += ras.land[i] ? 1 : 0; }
  console.log('osm water cells', wc, '(expected ~ 40*30-100=1100 + river)', 'wood cells', lc, '(expected ~1200)');
  console.log('hole is empty:', ras.water[35 * W + 35] === 0, ' ring body filled:', ras.water[25 * W + 25] === 1);
  assert.equal(ras.landMask[20 * W + 20], 1, 'landmask polygons should rasterize as land');
  assert.equal(ras.landMask[100 * W + 100], 0, 'cells outside landmask polygons should remain ocean');
  const clippedQuery = G.buildOverpassQuery(bb, { water: true, land: false, roads: false, timeout: 25 });
  const clippedBounds = [bb.s, bb.w, bb.n, bb.e].map(v => v.toFixed(6)).join(',');
  if (!clippedQuery.startsWith('[out:json][timeout:25];')) throw new Error('Overpass query timeout was not applied');
  if (!clippedQuery.endsWith('out geom(' + clippedBounds + ');')) throw new Error('Overpass geometry must be clipped to the map bounds');
  console.log('query:\\n' + clippedQuery.split('\\n').slice(0, 4).join('\\n'));
  // DEM sampler test using synthetic tiles
  const z = G.demZoom(geo, 64); const rg = G.demRange(geo, z);
  console.log('dem z', z, 'tiles', (rg.tx1 - rg.tx0 + 1) * (rg.ty1 - rg.ty0 + 1));
  const e2 = G.sampleDem(geo, z, (tx, ty) => { const a = new Int16Array(65536).fill(2000); return a; });
  console.log('dem sample', e2[0], e2[W * H - 1]);
})();
