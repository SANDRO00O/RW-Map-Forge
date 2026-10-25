/* RW Map Forge - core generation logic (pure functions; runs in the browser, in a Web Worker and in Node for tests) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RWGen = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------ classes ---
  const C = { DEEP: 0, WATER: 1, SHALLOW: 2, SAND: 3, DIRT: 4, GRASS: 5, STONE: 6, MOUNTAIN: 7, SNOW: 8 };
  const NCLS = 9;
  const CLS_NAMES = ['Deep water', 'Water', 'Water', 'Sand', 'Dirt', 'Grass', 'Stone', 'Mountain', 'Snow'];
  const CLS_COLORS = ['#0a2f66', '#1b5fb5', '#3b86d8', '#d8bd8a', '#8a5a3a', '#3f7d2e', '#7b7b7b', '#8c6d57', '#eef3f8'];
  const TEAM_COLORS = ['#e53935', '#1e88e5', '#43a047', '#fdd835', '#8e24aa', '#fb8c00', '#00acc1', '#6d4c41', '#ec407a', '#9e9e9e'];

  // Fill tile per class: local id 0 only (as in real maps; the other ids are decorations or carry special properties).
  // All water = Shallow Water id 0 (the tile that carries the 'water' property).
  const BASE_SETS = [
    ['shallowwater', [0]], ['shallowwater', [0]], ['shallowwater', [0]],
    ['sand', [0]], ['dirt', [0]], ['longgrass', [0]], ['mountain', [0]], ['mountain', [0]], ['snow', [0]],
  ];

  // [outside, inside, transition image]: the 'inside' cell is the one that receives the edge tile.
  // Only _flat sets with the 3x7 layout (ring 0-8 + inner corners 12/14/18/20); this layout is confirmed by a working map.
  const RIM_DEF = [
    [C.SAND, C.SHALLOW, 'sand2shallowwater_flat'],
    [C.GRASS, C.SHALLOW, 'longgrass2shallowwater_flat'],
    [C.MOUNTAIN, C.SHALLOW, 'mountain2shallowwater_flat'],
    [C.SAND, C.GRASS, 'sand2longgrass_flat'],
    [C.SAND, C.DIRT, 'sand2dirt_flat'],
    [C.GRASS, C.DIRT, 'longgrass2dirt_flat'],
    [C.MOUNTAIN, C.DIRT, 'mountain2dirt_flat'],
    [C.MOUNTAIN, C.GRASS, 'mountain2longgrass_flat'],
    [C.MOUNTAIN, C.SAND, 'mountain2sand_flat'],
    [C.MOUNTAIN, C.SNOW, 'mountain2snow_flat'],
    [C.SNOW, C.DIRT, 'snow2dirt_flat'],
  ];
  const RIM = new Array(NCLS * NCLS).fill(null);
  const RIMOK = new Uint8Array(NCLS * NCLS);
  RIM_DEF.forEach(function (r) { RIM[r[0] * NCLS + r[1]] = r[2]; RIMOK[r[0] * NCLS + r[1]] = 1; });

  const BUILDABLE = new Uint8Array(NCLS);
  [C.SAND, C.DIRT, C.GRASS, C.SNOW].forEach(function (c) { BUILDABLE[c] = 1; });

  // Tile ids in units.tsx (team 0..9) and misc.tsx
  const CC_TILE = [6, 51, 87, 105, 141, 154, 156, 158, 160, 178];
  const BUILDER_TILE = [1, 46, 82, 100, 136, 153, 155, 157, 159, 177];
  const POOL_TILE = 4;
  const TREE_TILES = [10, 11, 12, 13, 14];

  const DEFAULTS = {
    seaLevel: 0, smooth: 1,
    mountPct: 12, stonePct: 8, minSlope: 0.12,
    base: 'auto', snowShift: 0, beach: true, beachW: 2,
    urbanDirt: true, roads: false, treeDensity: 0.45, seed: 1,
  };

  // ------------------------------------------------------------ helpers ---
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash2(x, y, s) {
    let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s | 0, 2147483647)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  // ------------------------------------------------------- map projection ---
  const R_EARTH = 6378137;
  const MERC_HALF = Math.PI * R_EARTH; // 20037508.34...
  function merc(lat, lon) {
    return [R_EARTH * lon * Math.PI / 180, R_EARTH * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))];
  }
  function unmerc(x, y) {
    return [(2 * Math.atan(Math.exp(y / R_EARTH)) - Math.PI / 2) * 180 / Math.PI, x / R_EARTH * 180 / Math.PI];
  }
  // Square-cell map in Web Mercator; real meters per tile = mpt at the centre latitude
  function makeGeo(lat0, lon0, W, H, mpt) {
    const c = merc(lat0, lon0);
    const k = mpt / Math.cos(lat0 * Math.PI / 180);
    const x0 = c[0] - W * k / 2, yTop = c[1] + H * k / 2;
    return {
      k: k, x0: x0, yTop: yTop, W: W, H: H, mpt: mpt,
      toCell: function (lat, lon) { const m = merc(lat, lon); return [(m[0] - x0) / k, (yTop - m[1]) / k]; },
      bbox: function () {
        const sw = unmerc(x0, yTop - H * k), ne = unmerc(x0 + W * k, yTop);
        return { s: sw[0], w: sw[1], n: ne[0], e: ne[1] };
      },
    };
  }

  // ------------------------------------------------------- elevation sampling ---
  function demZoom(geo, maxTiles) {
    let z = Math.ceil(Math.log2(2 * MERC_HALF / (256 * geo.k)));
    z = clamp(z, 0, 15);
    for (; ;) {
      const r = demRange(geo, z);
      if ((r.tx1 - r.tx0 + 1) * (r.ty1 - r.ty0 + 1) <= maxTiles || z <= 0) return z;
      z--;
    }
  }
  function demRange(geo, z) {
    const P = 256 * Math.pow(2, z), n = Math.pow(2, z) - 1;
    const pxa = (geo.x0 + MERC_HALF) / (2 * MERC_HALF) * P;
    const pxb = (geo.x0 + geo.W * geo.k + MERC_HALF) / (2 * MERC_HALF) * P;
    const pya = (MERC_HALF - geo.yTop) / (2 * MERC_HALF) * P;
    const pyb = (MERC_HALF - (geo.yTop - geo.H * geo.k)) / (2 * MERC_HALF) * P;
    return {
      P: P,
      tx0: clamp(Math.floor((pxa - 1) / 256), 0, n), tx1: clamp(Math.floor((pxb + 1) / 256), 0, n),
      ty0: clamp(Math.floor((pya - 1) / 256), 0, n), ty1: clamp(Math.floor((pyb + 1) / 256), 0, n),
    };
  }
  // getTile(tx,ty) -> Int16Array(256*256) in half-meter units, or null
  function sampleDem(geo, z, getTile) {
    const W = geo.W, H = geo.H, P = 256 * Math.pow(2, z);
    const out = new Float32Array(W * H);
    const lastG = P - 1;
    function px(gx, gy) {
      gx = clamp(gx, 0, lastG); gy = clamp(gy, 0, lastG);
      const t = getTile(gx >> 8, gy >> 8);
      return t ? t[((gy & 255) << 8) | (gx & 255)] * 0.5 : NaN;
    }
    let bad = 0;
    for (let j = 0; j < H; j++) {
      const ym = geo.yTop - (j + 0.5) * geo.k;
      const v = (MERC_HALF - ym) / (2 * MERC_HALF) * P - 0.5;
      const y0 = Math.floor(v), fy = v - y0;
      for (let i = 0; i < W; i++) {
        const xm = geo.x0 + (i + 0.5) * geo.k;
        const u = (xm + MERC_HALF) / (2 * MERC_HALF) * P - 0.5;
        const x0 = Math.floor(u), fx = u - x0;
        const a = px(x0, y0), b = px(x0 + 1, y0), c = px(x0, y0 + 1), d = px(x0 + 1, y0 + 1);
        const e = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
        out[j * W + i] = e;
        if (e !== e) bad++;
      }
    }
    if (bad) fillNaN(out, W, H);
    return out;
  }
  function fillNaN(a, W, H) {
    let sum = 0, n = 0;
    for (let i = 0; i < a.length; i++) if (a[i] === a[i]) { sum += a[i]; n++; }
    const fb = n ? sum / n : 200;
    for (let it = 0; it < 2; it++) {
      for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
        const k = j * W + i;
        if (a[k] !== a[k]) {
          const l = i > 0 ? a[k - 1] : NaN, u = j > 0 ? a[k - W] : NaN;
          a[k] = l === l ? l : u === u ? u : NaN;
        }
      }
      for (let j = H - 1; j >= 0; j--) for (let i = W - 1; i >= 0; i--) {
        const k = j * W + i;
        if (a[k] !== a[k]) {
          const r = i < W - 1 ? a[k + 1] : NaN, d = j < H - 1 ? a[k + W] : NaN;
          a[k] = r === r ? r : d === d ? d : NaN;
        }
      }
    }
    for (let i = 0; i < a.length; i++) if (a[i] !== a[i]) a[i] = fb;
  }

  // ------------------------------------------------------ image processing ---
  function blur3(src, W, H) {
    const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      const o = y * W;
      for (let x = 0; x < W; x++) {
        tmp[o + x] = (src[o + (x > 0 ? x - 1 : 0)] + src[o + x] + src[o + (x < W - 1 ? x + 1 : W - 1)]) / 3;
      }
    }
    for (let y = 0; y < H; y++) {
      const a = (y > 0 ? y - 1 : 0) * W, b = y * W, c = (y < H - 1 ? y + 1 : H - 1) * W;
      for (let x = 0; x < W; x++) out[b + x] = (tmp[a + x] + tmp[b + x] + tmp[c + x]) / 3;
    }
    return out;
  }
  // 3-4 chamfer distance (unit = 1/3 tile). seed=1 means distance zero
  function chamfer(seed, W, H) {
    const INF = 60000, d = new Uint16Array(W * H);
    for (let i = 0; i < d.length; i++) d[i] = seed[i] ? 0 : INF;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x; let v = d[i]; if (!v) continue;
      if (x > 0) { v = Math.min(v, d[i - 1] + 3); if (y > 0) v = Math.min(v, d[i - W - 1] + 4); }
      if (y > 0) { v = Math.min(v, d[i - W] + 3); if (x < W - 1) v = Math.min(v, d[i - W + 1] + 4); }
      d[i] = v;
    }
    for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x; let v = d[i]; if (!v) continue;
      if (x < W - 1) { v = Math.min(v, d[i + 1] + 3); if (y < H - 1) v = Math.min(v, d[i + W + 1] + 4); }
      if (y < H - 1) { v = Math.min(v, d[i + W] + 3); if (x > 0) v = Math.min(v, d[i + W - 1] + 4); }
      d[i] = v;
    }
    return d;
  }
  function majority(mask, W, H, passes) {
    let cur = mask;
    for (let p = 0; p < passes; p++) {
      const nx = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = clamp(y + dy, 0, H - 1);
          for (let dx = -1; dx <= 1; dx++) s += cur[yy * W + clamp(x + dx, 0, W - 1)];
        }
        nx[y * W + x] = s >= 5 ? 1 : 0;
      }
      cur = nx;
    }
    return cur;
  }
  function snowline(lat, shift) {
    const a = Math.abs(lat);
    const pts = [[0, 5000], [20, 5200], [40, 3400], [50, 2700], [60, 1500], [70, 500], [80, 0], [90, 0]];
    let v = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      if (a <= pts[i + 1][0]) { const t = (a - pts[i][0]) / (pts[i + 1][0] - pts[i][0]); v = pts[i][1] + t * (pts[i + 1][1] - pts[i][1]); break; }
    }
    return Math.max(0, v + (shift || 0));
  }
  function percentile(arr, n, q) {
    if (!n) return Infinity;
    const sub = arr.subarray(0, n); sub.sort();
    return sub[clamp(Math.floor(q * (n - 1)), 0, n - 1)];
  }

  // ------------------------------------------------------ classification ---
  // inp: {W,H,mpt,lat,elev:Float32Array, water?:Uint8Array, land?:Uint8Array, road?:Uint8Array}
  function classify(inp, pp) {
    const p = Object.assign({}, DEFAULTS, pp || {});
    const W = inp.W, H = inp.H, N = W * H, mpt = inp.mpt;
    let e = inp.elev;
    for (let i = 0; i < p.smooth; i++) e = blur3(e, W, H);

    const osmWater = inp.water, osmLand = inp.land, osmRoad = inp.road;
    const water = new Uint8Array(N), sea = new Uint8Array(N), land = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const lowSea = e[i] <= p.seaLevel;
      const w = lowSea || (osmWater && osmWater[i]) || (osmLand && osmLand[i] === 7);
      water[i] = w ? 1 : 0; sea[i] = lowSea ? 1 : 0; land[i] = w ? 0 : 1;
    }
    const cls = new Uint8Array(N);

    // terrain slope
    const slope = new Float32Array(N);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const gx = (e[y * W + Math.min(W - 1, x + 1)] - e[y * W + Math.max(0, x - 1)]) / (2 * mpt);
      const gy = (e[Math.min(H - 1, y + 1) * W + x] - e[Math.max(0, y - 1) * W + x]) / (2 * mpt);
      slope[i] = Math.sqrt(gx * gx + gy * gy);
    }
    const tmpS = new Float32Array(N); let nl = 0;
    for (let i = 0; i < N; i++) if (land[i]) tmpS[nl++] = slope[i];
    const thM = Math.max(percentile(tmpS, nl, 1 - p.mountPct / 100), p.minSlope);
    // refill the scratch array because sort() reordered it
    let nl2 = 0; for (let i = 0; i < N; i++) if (land[i]) tmpS[nl2++] = slope[i];
    const thS = Math.max(percentile(tmpS, nl2, 1 - (p.mountPct + p.stonePct) / 100), p.minSlope * 0.55);
    let mMask = new Uint8Array(N), sMask = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (!land[i]) continue;
      if (p.mountPct > 0 && slope[i] >= thM) mMask[i] = 1;
      else if (p.stonePct > 0 && slope[i] >= thS) sMask[i] = 1;
    }
    mMask = majority(mMask, W, H, 2); sMask = majority(sMask, W, H, 1);

    const lat = inp.lat || 0;
    let base = C.GRASS;
    if (p.base === 'dirt') base = C.DIRT; else if (p.base === 'sand') base = C.SAND; else if (p.base === 'snow') base = C.SNOW;
    else if (p.base === 'auto' && Math.abs(lat) > 66) base = C.SNOW;
    const sl = snowline(lat, p.snowShift), alpine = sl > 800 ? sl * 0.75 : 1e9;
    const dLand = p.beach ? chamfer(water, W, H) : null; // for land cells: distance to water
    const treeCand = new Uint8Array(N);

    for (let i = 0; i < N; i++) {
      if (water[i]) {
        cls[i] = C.SHALLOW;   // all water is a single tile (Shallow Water id 0); no deep water
        continue;
      }
      let c = base; const el = e[i];
      if (el > sl) c = C.SNOW; else if (el > alpine && c === C.GRASS) c = C.DIRT;
      const lc = osmLand ? osmLand[i] : 0;
      if (lc === 1) { treeCand[i] = 1; if (c !== C.SNOW && c !== C.SAND) c = C.GRASS; }
      else if (lc === 2) c = C.SAND;
      else if (lc === 3) c = C.DIRT;
      else if (lc === 4) { if (p.urbanDirt && c !== C.SNOW) c = C.DIRT; }
      else if (lc === 5) { if (c !== C.SNOW) c = C.GRASS; }
      else if (lc === 6) c = C.SNOW;
      if (sMask[i] && c !== C.SNOW && c !== C.SAND) c = C.DIRT;
      if (dLand && dLand[i] / 3 <= p.beachW && el < 25 && c !== C.SNOW) c = C.SAND;
      if (osmRoad && osmRoad[i] && p.roads) c = C.DIRT;
      if (mMask[i]) c = C.MOUNTAIN;
      cls[i] = c;
    }
    finalizeClasses(cls, W, H);

    // hillshade for the preview
    const shade = new Uint8Array(N), ex = 3;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const dzdx = (e[y * W + Math.min(W - 1, x + 1)] - e[y * W + Math.max(0, x - 1)]) / (2 * mpt) * ex;
      const dzdy = (e[Math.min(H - 1, y + 1) * W + x] - e[Math.max(0, y - 1) * W + x]) / (2 * mpt) * ex;
      const nz = 1 / Math.sqrt(dzdx * dzdx + dzdy * dzdy + 1);
      const dot = (dzdx * 0.5 + dzdy * 0.5 + 0.7) * nz / 0.99; // light from the north-west
      shade[y * W + x] = clamp(Math.round(dot / 0.707 * 100), 45, 190);
    }
    return { cls: cls, shade: shade, treeCand: treeCand, thresholds: { mountain: thM, stone: thS, snowline: sl } };
  }

  function supported(a, b) { return a === b || RIMOK[a * NCLS + b] === 1 || RIMOK[b * NCLS + a] === 1; }
  // Removes adjacencies that have no original transition tileset (snow next to grass/sand/water, water next to land, ...)
  // by inserting a two-cell dirt belt between snow and whatever it cannot connect to.
  function fixUnsupported(cls, W, H) {
    let changed = 0; const bad = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, c = cls[i];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const n = cls[yy * W + xx];
        if (supported(c, n)) continue;
        if (c === C.SNOW) bad[i] = 1;                                       // dirt belt inside the snow
        else if (n === C.SNOW || c === C.SHALLOW) { /* handled from the other side */ }
        else if (c === C.DIRT && n === C.SHALLOW) { cls[i] = C.SAND; changed++; }   // dirt next to water -> sand
        else if (c !== C.MOUNTAIN) { cls[i] = C.DIRT; changed++; }
      }
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {   // grow the belt by one cell inside the snow
      const i = y * W + x; if (!bad[i]) continue;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        if (cls[yy * W + xx] === C.SNOW) bad[yy * W + xx] = bad[yy * W + xx] || 2;
      }
    }
    for (let i = 0; i < W * H; i++) if (bad[i] && cls[i] === C.SNOW) { cls[i] = C.DIRT; changed++; }
    return changed;
  }
  function finalizeClasses(cls, W, H) {
    for (let k = 0; k < 4; k++) {
      const a = fixUnsupported(cls, W, H);
      regularize(cls, W, H, 6);
      if (!a) break;
    }
  }
  // Removes cases that have no transition tile (1-wide strips or narrow tips)
  function regularize(cls, W, H, passes) {
    for (let p = 0; p < passes; p++) {
      let changed = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x, c = cls[i];
        const nN = y > 0 ? cls[i - W] : c, nS = y < H - 1 ? cls[i + W] : c;
        const nW = x > 0 ? cls[i - 1] : c, nE = x < W - 1 ? cls[i + 1] : c;
        const oN = nN !== c && RIMOK[nN * NCLS + c], oS = nS !== c && RIMOK[nS * NCLS + c];
        const oW = nW !== c && RIMOK[nW * NCLS + c], oE = nE !== c && RIMOK[nE * NCLS + c];
        const cnt = (oN ? 1 : 0) + (oS ? 1 : 0) + (oW ? 1 : 0) + (oE ? 1 : 0);
        if ((oN && oS) || (oW && oE) || cnt >= 3) {
          const t = {}; let best = -1, bc = 0;
          [[oN, nN], [oS, nS], [oW, nW], [oE, nE]].forEach(function (a) {
            if (!a[0]) return; t[a[1]] = (t[a[1]] || 0) + 1;
            if (t[a[1]] > bc) { bc = t[a[1]]; best = a[1]; }
          });
          if (best >= 0) { cls[i] = best; changed++; }
        }
      }
      if (!changed) break;
    }
  }

  // ------------------------------------------------------------ autotiling ---
  function makeReg() {
    const ids = [], idx = {};
    return {
      ids: ids,
      code: function (id, local) {
        let k = idx[id];
        if (k === undefined) { k = ids.length; ids.push(id); idx[id] = k; }
        return ((k + 1) << 12) | local;
      },
    };
  }
  // cell value = ((set index + 1) << 12) | local tile id
  function autotile(cls, W, H, reg, seed) {
    const g = new Uint32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, c = cls[i];
      const nb = function (dx, dy) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) return -1;
        const n = cls[yy * W + xx];
        return (n !== c && RIMOK[n * NCLS + c]) ? n : -1;
      };
      const oN = nb(0, -1), oS = nb(0, 1), oW = nb(-1, 0), oE = nb(1, 0);
      const oNW = nb(-1, -1), oNE = nb(1, -1), oSW = nb(-1, 1), oSE = nb(1, 1);
      let tile = -1, tset = null;
      if (oN >= 0 || oS >= 0 || oW >= 0 || oE >= 0 || oNW >= 0 || oNE >= 0 || oSW >= 0 || oSE >= 0) {
        let idx = -1;
        if (!((oN >= 0 && oS >= 0) || (oW >= 0 && oE >= 0))) {
          if (oN >= 0) idx = oW >= 0 ? 0 : oE >= 0 ? 2 : 1;
          else if (oS >= 0) idx = oW >= 0 ? 6 : oE >= 0 ? 8 : 7;
          else if (oW >= 0) idx = 3;
          else if (oE >= 0) idx = 5;
          else if (oNW >= 0) idx = 12;
          else if (oNE >= 0) idx = 14;
          else if (oSW >= 0) idx = 18;
          else if (oSE >= 0) idx = 20;
        }
        if (idx >= 0) {
          const cnt = {}; let best = -1, bc = 0;
          [[oN, 2], [oS, 2], [oW, 2], [oE, 2], [oNW, 1], [oNE, 1], [oSW, 1], [oSE, 1]].forEach(function (a) {
            if (a[0] < 0) return; cnt[a[0]] = (cnt[a[0]] || 0) + a[1];
            if (cnt[a[0]] > bc) { bc = cnt[a[0]]; best = a[0]; }
          });
          tset = RIM[best * NCLS + c]; tile = idx;
        }
      }
      if (tset) g[i] = reg.code(tset, tile);
      else {
        const b = BASE_SETS[c], v = b[1];
        g[i] = reg.code(b[0], v[Math.floor(hash2(x, y, seed) * v.length)]);
      }
    }
    return g;
  }

  // ----------------------------------------------------- trees / players / resources ---
  function isBuildable(cls, W, H, x, y, r) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) return false;
      if (!BUILDABLE[cls[yy * W + xx]]) return false;
    }
    return true;
  }
  // Makes the circle buildable (removes water, mountains and trees)
  function flatten(st, x, y, r) {
    const W = st.W, H = st.H, cls = st.cls;
    const cnt = new Array(NCLS).fill(0);
    for (let dy = -r - 3; dy <= r + 3; dy++) for (let dx = -r - 3; dx <= r + 3; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const c = cls[yy * W + xx]; if (BUILDABLE[c] && c !== C.SNOW) cnt[c]++;
    }
    let fill = C.GRASS, bc = 0;
    for (let c = 0; c < NCLS; c++) if (cnt[c] > bc) { bc = cnt[c]; fill = c; }
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const i = yy * W + xx;
      if (!BUILDABLE[cls[i]]) cls[i] = fill;
      st.trees[i] = 0;
    }
    finalizeClasses(cls, W, H);
  }
  function placeTrees(st, density, seed) {
    const N = st.W * st.H, rnd = mulberry32(seed + 77);
    st.trees = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (!st.treeCand[i]) continue;
      const c = st.cls[i]; if (c !== C.GRASS && c !== C.DIRT) continue;
      if (rnd() < density) st.trees[i] = 1 + Math.floor(rnd() * TREE_TILES.length);
    }
  }
  function clearTreesAround(st, x, y, r) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= st.W || yy >= st.H) continue;
      if (dx * dx + dy * dy <= r * r) st.trees[yy * st.W + xx] = 0;
    }
  }
  function autoSpawns(st, n, seed) {
    const W = st.W, H = st.H, rnd = mulberry32(seed + 5);
    const cx = W / 2, cy = H / 2, rad = Math.min(W, H) * (n === 2 ? 0.36 : 0.38);
    const off = rnd() * Math.PI * 2, out = [];
    const used = [];
    for (let k = 0; k < n; k++) {
      const a = off + (2 * Math.PI * k) / n;
      const tx = Math.round(cx + Math.cos(a) * rad), ty = Math.round(cy + Math.sin(a) * rad);
      let best = null, bd = 1e9;
      const R = Math.max(10, Math.round(Math.min(W, H) * 0.18));
      for (let dy = -R; dy <= R; dy += 2) for (let dx = -R; dx <= R; dx += 2) {
        const x = tx + dx, y = ty + dy;
        if (x < 8 || y < 8 || x >= W - 8 || y >= H - 8) continue;
        if (!isBuildable(st.cls, W, H, x, y, 5)) continue;
        const d = dx * dx + dy * dy; if (d < bd) { bd = d; best = [x, y]; }
      }
      let x, y, fl = false;
      if (best) { x = best[0]; y = best[1]; } else { x = clamp(tx, 8, W - 9); y = clamp(ty, 8, H - 9); fl = true; }
      used.push([x, y, fl]);
      out.push({ x: x, y: y, team: k, flat: fl });
    }
    return out;
  }
  // 3x3 block fully buildable (an extractor / resource pool occupies 3x3 tiles)
  function blockOK(st, x, y) {
    if (x < 1 || y < 1 || x >= st.W - 1 || y >= st.H - 1) return false;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (!BUILDABLE[st.cls[(y + dy) * st.W + x + dx]]) return false;
    return true;
  }
  function autoPools(st, spawns, neutral, seed) {
    const W = st.W, H = st.H, rnd = mulberry32(seed + 11), pools = [];
    const near = function (x, y, d) { return pools.some(function (p) { return Math.abs(p.x - x) < d && Math.abs(p.y - y) < d; }); };
    spawns.forEach(function (s) {
      const a0 = rnd() * Math.PI * 2; let got = 0;
      for (let t = 0; t < 60 && got < 4; t++) {
        const a = a0 + got * (Math.PI / 2) + (rnd() - 0.5) * 0.9, d = 8 + rnd() * 3;
        const x = Math.round(s.x + Math.cos(a) * d), y = Math.round(s.y + Math.sin(a) * d);
        if (!blockOK(st, x, y) || near(x, y, 4)) continue;
        if (Math.abs(x - s.x - 3) < 3 && Math.abs(y - s.y - 3) < 3) continue;   // do not cover the builder spot
        pools.push({ x: x, y: y }); got++;
      }
    });
    let tries = 0;
    while (neutral > 0 && tries++ < neutral * 120) {
      const x = 4 + Math.floor(rnd() * (W - 8)), y = 4 + Math.floor(rnd() * (H - 8));
      if (!blockOK(st, x, y)) continue;
      if (spawns.some(function (s) { return (s.x - x) * (s.x - x) + (s.y - y) * (s.y - y) < 144; })) continue;
      if (near(x, y, 14)) continue;
      pools.push({ x: x, y: y }); neutral--;
    }
    return pools;
  }
  function stats(cls) {
    const n = new Array(NCLS).fill(0);
    for (let i = 0; i < cls.length; i++) n[cls[i]]++;
    return n.map(function (v) { return v / cls.length; });
  }

  // ------------------------------------------------------ OSM conversion ---
  function fillRings(rings, W, H, plot) {
    const rows = new Array(H);
    rings.forEach(function (r) {
      const n = r.length / 2; if (n < 3) return;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        let x1 = r[2 * i], y1 = r[2 * i + 1], x2 = r[2 * j], y2 = r[2 * j + 1];
        if (y1 === y2) continue;
        if (y1 > y2) { let t = x1; x1 = x2; x2 = t; t = y1; y1 = y2; y2 = t; }
        let ya = Math.ceil(y1 - 0.5), yb = Math.ceil(y2 - 0.5) - 1;
        if (ya < 0) ya = 0; if (yb > H - 1) yb = H - 1;
        const dx = (x2 - x1) / (y2 - y1);
        for (let y = ya; y <= yb; y++) (rows[y] || (rows[y] = [])).push(x1 + (y + 0.5 - y1) * dx);
      }
    });
    for (let y = 0; y < H; y++) {
      const xs = rows[y]; if (!xs) continue;
      xs.sort(function (a, b) { return a - b; });
      for (let k = 0; k + 1 < xs.length; k += 2) {
        let a = Math.ceil(xs[k] - 0.5), b = Math.ceil(xs[k + 1] - 0.5);
        if (a < 0) a = 0; if (b > W) b = W;
        if (b > a) plot(y, a, b);
      }
    }
  }
  function strokeLine(pts, W, H, radius, plotCell) {
    for (let s = 0; s + 3 < pts.length; s += 2) {
      const x1 = pts[s], y1 = pts[s + 1], x2 = pts[s + 2], y2 = pts[s + 3];
      const len = Math.hypot(x2 - x1, y2 - y1), steps = Math.max(1, Math.ceil(len / 0.5));
      for (let t = 0; t <= steps; t++) {
        const cx = x1 + (x2 - x1) * t / steps, cy = y1 + (y2 - y1) * t / steps;
        for (let yy = Math.floor(cy - radius); yy <= Math.ceil(cy + radius); yy++) {
          if (yy < 0 || yy >= H) continue;
          for (let xx = Math.floor(cx - radius); xx <= Math.ceil(cx + radius); xx++) {
            if (xx < 0 || xx >= W) continue;
            const dx = xx + 0.5 - cx, dy = yy + 0.5 - cy;
            if (dx * dx + dy * dy <= radius * radius) plotCell(xx, yy);
          }
        }
      }
    }
  }
  function stitchRings(segs) {
    const rings = [], used = new Array(segs.length).fill(false), ends = new Map();
    const key = function (p) { return p[0] + ',' + p[1]; };
    segs.forEach(function (s, i) {
      if (s.length < 2) return;
      [s[0], s[s.length - 1]].forEach(function (p) {
        const k = key(p); let l = ends.get(k); if (!l) { l = []; ends.set(k, l); } l.push(i);
      });
    });
    for (let i = 0; i < segs.length; i++) {
      if (used[i] || segs[i].length < 2) continue;
      used[i] = true; let ring = segs[i].slice();
      for (; ;) {
        const first = key(ring[0]), last = key(ring[ring.length - 1]);
        if (first === last && ring.length > 3) break;
        const cand = (ends.get(last) || []).find(function (j) { return !used[j]; });
        if (cand === undefined) break;
        used[cand] = true; const s = segs[cand];
        ring = ring.concat(key(s[0]) === last ? s.slice(1) : s.slice(0, -1).reverse());
      }
      rings.push(ring);
    }
    return rings;
  }
  const LAND_PRIO = { 5: 1, 4: 2, 2: 3, 3: 4, 1: 5, 6: 6 };
  function landCode(t) {
    const lu = t.landuse, nat = t.natural;
    if (nat === 'glacier') return 6;
    if (lu === 'forest' || nat === 'wood') return 1;
    if (nat === 'bare_rock' || nat === 'scree' || nat === 'rock' || nat === 'shingle') return 3;
    if (nat === 'sand' || nat === 'beach' || nat === 'dune' || nat === 'desert') return 2;
    if (lu === 'residential' || lu === 'commercial' || lu === 'industrial' || lu === 'retail' || lu === 'garages') return 4;
    if (/^(farmland|meadow|grass|orchard|vineyard|allotments|recreation_ground|village_green)$/.test(lu || '') ||
      /^(grassland|scrub|heath|wetland)$/.test(nat || '')) return 5;
    return 0;
  }
  function isWaterArea(t) { return t.natural === 'water' || t.waterway === 'riverbank' || t.landuse === 'reservoir'; }

  function rasterizeOsm(json, geo, W, H, o) {
    o = o || {};
    const water = new Uint8Array(W * H), land = new Uint8Array(W * H), road = new Uint8Array(W * H);
    const els = (json && json.elements) || [];
    const toCellArr = function (pts) {
      const a = new Float64Array(pts.length * 2);
      for (let i = 0; i < pts.length; i++) { const c = geo.toCell(pts[i][0], pts[i][1]); a[2 * i] = c[0]; a[2 * i + 1] = c[1]; }
      return a;
    };
    const geom = function (g) { return g.map(function (p) { return [p.lat, p.lon]; }); };
    const paintWater = function (rings) { fillRings(rings, W, H, function (y, a, b) { for (let x = a; x < b; x++) water[y * W + x] = 1; }); };
    const paintLand = function (rings, code) {
      const pr = LAND_PRIO[code];
      fillRings(rings, W, H, function (y, a, b) {
        for (let x = a; x < b; x++) { const k = y * W + x, old = land[k]; if (!old || pr >= LAND_PRIO[old]) land[k] = code; }
      });
    };
    els.forEach(function (el) {
      const t = el.tags || {};
      let rings = null;
      if (el.type === 'way' && el.geometry && el.geometry.length > 1) {
        const g = geom(el.geometry);
        const closed = g[0][0] === g[g.length - 1][0] && g[0][1] === g[g.length - 1][1];
        if (t.waterway && /^(river|canal)$/.test(t.waterway)) {
          if (o.water === false) return;
          const wm = parseFloat(t.width) || (t.waterway === 'river' ? 25 : 10);
          const r = clamp(wm / geo.mpt / 2, 1.0, 8);
          strokeLine(toCellArr(g), W, H, r, function (x, y) { water[y * W + x] = 1; });
          return;
        }
        if (t.highway && o.roads) {
          if (!/^(motorway|trunk|primary|secondary|tertiary)$/.test(t.highway)) return;
          if (t.highway === 'tertiary' && geo.mpt > 40) return;
          strokeLine(toCellArr(g), W, H, 1.0, function (x, y) { road[y * W + x] = 1; });
          return;
        }
        if (closed) rings = [toCellArr(g)];
      } else if (el.type === 'relation' && el.members) {
        const segs = [];
        el.members.forEach(function (m) { if (m.type === 'way' && m.geometry && m.geometry.length > 1) segs.push(geom(m.geometry)); });
        if (segs.length) rings = stitchRings(segs).map(toCellArr);
      }
      if (!rings) return;
      if (isWaterArea(t)) { if (o.water !== false) paintWater(rings); return; }
      if (o.land !== false) { const code = landCode(t); if (code) paintLand(rings, code); }
    });
    return { water: water, land: land, road: road };
  }
  function buildOverpassQuery(bbox, o) {
    const B = '(' + [bbox.s, bbox.w, bbox.n, bbox.e].map(function (v) { return v.toFixed(6); }).join(',') + ')';
    const q = [];
    if (o.water) {
      q.push('way["natural"="water"]' + B + ';', 'relation["natural"="water"]' + B + ';',
        'way["waterway"="riverbank"]' + B + ';', 'relation["waterway"="riverbank"]' + B + ';',
        'way["landuse"="reservoir"]' + B + ';', 'way["waterway"~"^(river|canal)$"]' + B + ';');
    }
    if (o.land) {
      const lu = '^(forest|residential|commercial|industrial|retail|farmland|meadow|grass|orchard|vineyard)$';
      const nat = '^(wood|sand|beach|dune|desert|bare_rock|scree|glacier|grassland|scrub|heath|wetland)$';
      q.push('way["landuse"~"' + lu + '"]' + B + ';', 'relation["landuse"~"' + lu + '"]' + B + ';',
        'way["natural"~"' + nat + '"]' + B + ';', 'relation["natural"~"' + nat + '"]' + B + ';');
    }
    if (o.roads) q.push('way["highway"~"^(motorway|trunk|primary|secondary|tertiary)$"]' + B + ';');
    if (!q.length) return null;
    return '[out:json][timeout:' + (o.timeout || 25) + '];\n(\n' + q.join('\n') + '\n);\nout geom' + B + ';';
  }

  // ------------------------------------------------------------ TMX exporter ---
  function bytesToB64(u8) {
    if (typeof Buffer !== 'undefined') return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
    let s = ''; const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(s);
  }
  function u32ToBytes(arr) {
    const u8 = new Uint8Array(arr.length * 4);
    for (let i = 0, j = 0; i < arr.length; i++, j += 4) {
      const v = arr[i]; u8[j] = v & 255; u8[j + 1] = (v >>> 8) & 255; u8[j + 2] = (v >>> 16) & 255; u8[j + 3] = (v >>> 24) & 255;
    }
    return u8;
  }
  const NORM = function (s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); };
  function matchTemplate(e, t) {
    if (t.img && t.img === e.id) return true;
    if (t.src && e.tsx && t.src === NORM(e.tsx.replace(/^.*\//, '').replace(/\.tsx$/i, ''))) return true;
    if (t.name && t.name === NORM(e.name)) return true;
    return false;
  }
  function tilesetXml(e, gid, o) {
    if (o.tsMode === 'external' && e.tsx) return ' <tileset firstgid="' + gid + '" source="' + (o.extPrefix || '') + e.tsx + '"/>';
    return ' <tileset firstgid="' + gid + '" ' + e.attrs + '>' + e.inner + '</tileset>';
  }

  // st: {W,H,cls,ground,reg,trees,spawns:[{x,y,team}],pools:[{x,y}]}
  async function buildTmx(st, o, cat, pack) {
    const W = st.W, H = st.H, N = W * H;
    // 1) prepare layers as (set, local id)
    const reg = st.reg;
    const items = new Uint32Array(N), units = new Uint32Array(N);
    let treeN = 0;
    for (let i = 0; i < N; i++) {
      if (st.trees[i] && BUILDABLE[st.cls[i]]) { items[i] = reg.code('misc', TREE_TILES[(st.trees[i] - 1) % TREE_TILES.length]); treeN++; }
    }
    st.pools.forEach(function (p) {            // extractor = 3x3 block of misc (ids 0..8 in order)
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = p.x + dx, yy = p.y + dy;
        if (xx >= 0 && yy >= 0 && xx < W && yy < H) items[yy * W + xx] = reg.code('misc', (dy + 1) * 3 + (dx + 1));
      }
    });
    st.spawns.forEach(function (s) {
      units[s.y * W + s.x] = reg.code('units', CC_TILE[s.team]);
      if (o.builders) {
        const bx = Math.min(W - 1, s.x + 3), by = Math.min(H - 1, s.y + 3);   // diagonal, as in the original map
        units[by * W + bx] = reg.code('units', BUILDER_TILE[s.team]);
      }
    });
    // 2) assign firstgid
    const used = reg.ids.slice(), firstgid = {}, xmls = [];
    let next = 1;
    if (o.tsMode === 'template' && o.template && o.template.sets.length) {
      o.template.sets.forEach(function (t) { next = Math.max(next, t.gid + (t.count || 400)); });
      used.forEach(function (id) {
        const e = cat[id], t = o.template.sets.find(function (t) { return matchTemplate(e, t); });
        if (t) { firstgid[id] = t.gid; xmls.push({ gid: t.gid, xml: t.xml }); }
      });
    }
    used.forEach(function (id) {
      if (firstgid[id] !== undefined) return;
      const e = cat[id]; firstgid[id] = next; xmls.push({ gid: next, xml: tilesetXml(e, next, o) }); next += e.count;
    });
    xmls.sort(function (a, b) { return a.gid - b.gid; });
    // 3) convert values to gids
    const toGid = function (v) { return v ? firstgid[reg.ids[(v >>> 12) - 1]] + (v & 4095) : 0; };
    const gidLayer = function (arr) { const a = new Uint32Array(N); for (let i = 0; i < N; i++) a[i] = toGid(arr[i]); return a; };
    const layers = [['Ground', gidLayer(st.ground)], ['Items', gidLayer(items)], ['Units', gidLayer(units)]];

    const dataXml = async function (arr) {
      if (o.fmt === 'csv') {
        const rows = []; for (let y = 0; y < H; y++) rows.push(Array.prototype.join.call(arr.subarray(y * W, (y + 1) * W), ','));
        return '<data encoding="csv">\n' + rows.join(',\n') + '\n</data>';
      }
      const b64 = await pack(u32ToBytes(arr), o.fmt === 'zlib' ? 'zlib' : 'gzip');
      return '<data encoding="base64" compression="' + (o.fmt === 'zlib' ? 'zlib' : 'gzip') + '">' + b64 + '</data>';
    };
    const parts = ['<?xml version="1.0" encoding="UTF-8"?>',
      '<map version="1.0" tiledversion="1.1.3" orientation="orthogonal" renderorder="right-down" width="' + W + '" height="' + H +
      '" tilewidth="20" tileheight="20" infinite="0" nextobjectid="' + (o.mapInfo ? 2 : 1) + '">'];
    xmls.forEach(function (x) { parts.push(x.xml); });
    for (let k = 0; k < layers.length; k++) {
      parts.push(' <layer name="' + layers[k][0] + '" width="' + W + '" height="' + H + '">');
      parts.push('  ' + await dataXml(layers[k][1]));
      parts.push(' </layer>');
      layers[k][1] = null;
    }
    if (o.mapInfo) {
      parts.push(' <objectgroup name="Triggers">',
        '  <object id="1" name="map_info" x="0" y="0" width="20" height="20">',
        '   <properties>', '    <property name="type" value="' + (o.type || 'skirmish') + '"/>', '   </properties>',
        '  </object>', ' </objectgroup>');
    }
    parts.push('</map>');
    return { xml: parts.join('\n') + '\n', trees: treeN, tilesets: used.length };
  }

  return {
    C: C, NCLS: NCLS, CLS_NAMES: CLS_NAMES, CLS_COLORS: CLS_COLORS, TEAM_COLORS: TEAM_COLORS,
    BASE_SETS: BASE_SETS, RIM_DEF: RIM_DEF, RIM: RIM, BUILDABLE: BUILDABLE,
    CC_TILE: CC_TILE, BUILDER_TILE: BUILDER_TILE, POOL_TILE: POOL_TILE, TREE_TILES: TREE_TILES, DEFAULTS: DEFAULTS,
    mulberry32: mulberry32, hash2: hash2, merc: merc, unmerc: unmerc, makeGeo: makeGeo,
    demZoom: demZoom, demRange: demRange, sampleDem: sampleDem,
    classify: classify, regularize: regularize, makeReg: makeReg, autotile: autotile,
    isBuildable: isBuildable, flatten: flatten, placeTrees: placeTrees, clearTreesAround: clearTreesAround,
    finalizeClasses: finalizeClasses, supported: supported, autoSpawns: autoSpawns, autoPools: autoPools, blockOK: blockOK, stats: stats,
    rasterizeOsm: rasterizeOsm, buildOverpassQuery: buildOverpassQuery, fillRings: fillRings, stitchRings: stitchRings,
    buildTmx: buildTmx, bytesToB64: bytesToB64, u32ToBytes: u32ToBytes, NORM: NORM,
  };
});
