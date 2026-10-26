/* RW Map Forge - map editor (canvas preview, tools, players / resources / trees). */
(function () {
  'use strict';
  const G = window.RWGen, C = G.C;

  const Editor = {
    cv: null, st: null, cat: null, sets: {}, imgs: new Map(), mini: null,
    // Visible textured chunks are rendered once and reused while panning/zooming.
    chunkCache: new Map(),
    view: { cx: 0, cy: 0, s: 4 }, tool: 'pan', team: 0, hooks: {},
    hillshade: true, flatten: true,
  };
  const hex = (h) => [parseInt(h.substr(1, 2), 16), parseInt(h.substr(3, 2), 16), parseInt(h.substr(5, 2), 16)];

  Editor.init = function (o) {
    Editor.cv = o.canvas; Editor.cat = o.catalog; Editor.hooks = o.hooks || {};
    bindPointer();
    new ResizeObserver(() => { if (Editor.st) Editor.redraw(); }).observe(Editor.cv.parentElement);
  };

  /** state: {W,H,cls,shade,treeCand,trees,elev,spawns,pools,seed} */
  Editor.setState = function (state) { Editor.st = state; clearChunkCache(); };
  Editor.hasMap = () => !!Editor.st;

  /* ------------------------------------------------------------- tile images */
  function loadSet(id) {
    if (Editor.imgs.has(id)) return Editor.imgs.get(id);
    const e = Editor.cat[id];
    const p = new Promise((res) => {
      const im = new Image();
      im.onload = () => {
        const c = document.createElement('canvas');
        c.width = im.width; c.height = im.height;
        const x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(im, 0, 0);
        const d = x.getImageData(0, 0, c.width, c.height), a = d.data;
        const t = parseInt(e.trans || '008a76', 16), r = (t >> 16) & 255, g = (t >> 8) & 255, b = t & 255;
        for (let i = 0; i < a.length; i += 4) if (a[i] === r && a[i + 1] === g && a[i + 2] === b) a[i + 3] = 0;
        x.putImageData(d, 0, 0);
        res({ canvas: c, e: e });
      };
      im.onerror = () => res(null);
      im.src = e.png;
    });
    Editor.imgs.set(id, p);
    return p;
  }

  /** Re-runs the autotiler and refreshes the preview. */
  Editor.retile = async function () {
    const st = Editor.st;
    st.reg = G.makeReg();
    st.ground = G.autotile(st.cls, st.W, st.H, st.reg, st.seed);
    clearChunkCache();
    buildMini();
    const ids = st.reg.ids.concat(['misc']);
    const loaded = await Promise.all(ids.map(loadSet));
    Editor.sets = {};
    ids.forEach((id, i) => { Editor.sets[id] = loaded[i]; });
    clearChunkCache();
    Editor.redraw();
    changed();
  };
  function changed() { if (Editor.hooks.onChange) Editor.hooks.onChange(Editor.summary()); }

  function buildMini() {
    const st = Editor.st, W = st.W, H = st.H;
    if (!Editor.mini) Editor.mini = document.createElement('canvas');
    Editor.mini.width = W; Editor.mini.height = H;
    const x = Editor.mini.getContext('2d'), img = x.createImageData(W, H), d = img.data;
    const pal = G.CLS_COLORS.map(hex);
    for (let i = 0; i < W * H; i++) {
      const c = pal[st.cls[i]];
      const k = Editor.hillshade && st.cls[i] > C.SHALLOW ? 1 + (st.shade[i] - 100) / 100 * 0.55 : 1;
      d[4 * i] = Math.min(255, c[0] * k); d[4 * i + 1] = Math.min(255, c[1] * k); d[4 * i + 2] = Math.min(255, c[2] * k); d[4 * i + 3] = 255;
    }
    x.putImageData(img, 0, 0);
  }
  Editor.setHillshade = (v) => { Editor.hillshade = v; if (Editor.st) { buildMini(); Editor.redraw(); } };
  Editor.setFlatten = (v) => { Editor.flatten = v; };

  Editor.summary = function () {
    const st = Editor.st;
    if (!st) return { text: '', players: 0, pools: 0, trees: 0 };
    let trees = 0;
    for (let i = 0; i < st.trees.length; i++) if (st.trees[i]) trees++;
    return { W: st.W, H: st.H, players: st.spawns.length, pools: st.pools.length, trees: trees, teams: st.spawns.map((s) => s.team) };
  };

  /* ------------------------------------------------------------------- view */
  function resizeCanvas() {
    const cv = Editor.cv, dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  }
  Editor.fit = function () {
    const st = Editor.st; if (!st) return;
    resizeCanvas();
    const w = Editor.cv.clientWidth || 300, h = Editor.cv.clientHeight || 300, v = Editor.view;
    v.s = Math.max(0.3, Math.min((w - 90) / st.W, (h - 90) / st.H)); v.cx = st.W / 2; v.cy = st.H / 2;
    Editor.redraw();
  };
  Editor.zoom = function (f) { zoomAt(Editor.cv.clientWidth / 2, Editor.cv.clientHeight / 2, f); Editor.redraw(); };
  function zoomAt(mx, my, f) {
    const v = Editor.view, cv = Editor.cv;
    const cx = v.cx + (mx - cv.clientWidth / 2) / v.s, cy = v.cy + (my - cv.clientHeight / 2) / v.s;
    v.s = Math.max(0.25, Math.min(64, v.s * f));
    v.cx = cx - (mx - cv.clientWidth / 2) / v.s; v.cy = cy - (my - cv.clientHeight / 2) / v.s;
  }

  function drawTile(ctx, id, local, dx, dy, dw, dh) {
    const set = Editor.sets[id];
    if (!set) return;
    const e = set.e, sx = e.margin + (local % e.cols) * (e.tw + e.spacing), sy = e.margin + Math.floor(local / e.cols) * (e.th + e.spacing);
    ctx.drawImage(set.canvas, sx, sy, e.tw, e.th, dx, dy, dw, dh);
  }

  // Chunk size is expressed in map cells. The chunk canvas is intentionally
  // lower-res than the source sprites; pixelated tiles fit Rusted Warfare and
  // cap memory use on phones. Only visible chunks are built, and the LRU is
  // capped so exploring a 1000x1000 map cannot retain the entire map in RAM.
  const CHUNK_CELLS = 64;
  const CHUNK_PIXELS = 10;
  const MAX_CACHED_CHUNKS = 16;

  function clearChunkCache() {
    Editor.chunkCache.clear();
  }

  function invalidateCellChunk(x, y) {
    Editor.chunkCache.delete(Math.floor(x / CHUNK_CELLS) + ',' + Math.floor(y / CHUNK_CELLS));
  }

  function getChunkCanvas(st, cx, cy) {
    const key = cx + ',' + cy;
    const cached = Editor.chunkCache.get(key);
    if (cached) {
      // Refresh insertion order so frequently used chunks survive LRU eviction.
      Editor.chunkCache.delete(key);
      Editor.chunkCache.set(key, cached);
      return cached;
    }

    const x0 = cx * CHUNK_CELLS, y0 = cy * CHUNK_CELLS;
    const x1 = Math.min(st.W, x0 + CHUNK_CELLS), y1 = Math.min(st.H, y0 + CHUNK_CELLS);
    const width = (x1 - x0) * CHUNK_PIXELS, height = (y1 - y0) * CHUNK_PIXELS;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, width);
    canvas.height = Math.max(1, height);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#07090c';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (let y = y0; y < y1; y++) {
      const dy = (y - y0) * CHUNK_PIXELS;
      for (let x = x0; x < x1; x++) {
        const dx = (x - x0) * CHUNK_PIXELS;
        const g = st.ground[y * st.W + x];
        drawTile(ctx, st.reg.ids[(g >>> 12) - 1], g & 4095, dx, dy, CHUNK_PIXELS, CHUNK_PIXELS);
        const tree = st.trees[y * st.W + x];
        if (tree) drawTile(ctx, 'misc', G.TREE_TILES[(tree - 1) % G.TREE_TILES.length],
          dx, dy, CHUNK_PIXELS, CHUNK_PIXELS);
      }
    }

    Editor.chunkCache.set(key, canvas);
    while (Editor.chunkCache.size > MAX_CACHED_CHUNKS) {
      const oldest = Editor.chunkCache.keys().next().value;
      if (oldest === undefined) break;
      Editor.chunkCache.delete(oldest);
    }
    return canvas;
  }

  Editor.redraw = function () {
    if (!Editor.st || !Editor.st.ground) return;
    cancelAnimationFrame(Editor._raf);
    Editor._raf = requestAnimationFrame(paint);
  };

  function paint() {
    const st = Editor.st, cv = Editor.cv, v = Editor.view;
    resizeCanvas();
    const ctx = cv.getContext('2d'), dpr = window.devicePixelRatio || 1, W = st.W, H = st.H;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#07090c'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.imageSmoothingEnabled = false;
    const s = v.s * dpr, ox = cv.width / 2 - v.cx * s, oy = cv.height / 2 - v.cy * s;
    const x0 = Math.max(0, Math.floor(-ox / s)), x1 = Math.min(W, Math.ceil((cv.width - ox) / s));
    const y0 = Math.max(0, Math.floor(-oy / s)), y1 = Math.min(H, Math.ceil((cv.height - oy) / s));
    const tex = v.s >= 6;
    if (tex) {
      // Draw a few pre-rendered chunks instead of issuing one drawImage per
      // map cell on every animation frame.
      if (x1 > x0 && y1 > y0) {
        const cx0 = Math.floor(x0 / CHUNK_CELLS), cx1 = Math.floor((x1 - 1) / CHUNK_CELLS);
        const cy0 = Math.floor(y0 / CHUNK_CELLS), cy1 = Math.floor((y1 - 1) / CHUNK_CELLS);
        for (let cy = cy0; cy <= cy1; cy++) {
          const gy0 = cy * CHUNK_CELLS, gy1 = Math.min(H, gy0 + CHUNK_CELLS);
          const dy = Math.floor(oy + gy0 * s), dh = Math.floor(oy + gy1 * s) - dy;
          for (let cx = cx0; cx <= cx1; cx++) {
            const gx0 = cx * CHUNK_CELLS, gx1 = Math.min(W, gx0 + CHUNK_CELLS);
            const dx = Math.floor(ox + gx0 * s), dw = Math.floor(ox + gx1 * s) - dx;
            ctx.drawImage(getChunkCanvas(st, cx, cy), dx, dy, dw, dh);
          }
        }
      }
    } else {
      ctx.drawImage(Editor.mini, 0, 0, W, H, ox, oy, W * s, H * s);
      // At overview scales individual trees are sub-pixel; avoid scanning up to
      // one million cells for markers that cannot be seen.
      if (v.s >= 2) {
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
          if (!st.trees[y * W + x]) continue;
          const dx = ox + x * s, dy = oy + y * s;
          ctx.fillStyle = '#17420f';
          ctx.fillRect(dx, dy, Math.ceil(s * 0.8), Math.ceil(s * 0.8));
        }
      }
    }
    st.pools.forEach((p) => {
      const dx = ox + (p.x - 1) * s, dy = oy + (p.y - 1) * s;
      if (dx < -s * 3 || dy < -s * 3 || dx > cv.width || dy > cv.height) return;
      if (tex) {
        for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) drawTile(ctx, 'misc', j * 3 + i, Math.floor(dx + i * s), Math.floor(dy + j * s), Math.ceil(s), Math.ceil(s));
      } else {
        const sz = Math.max(4 * dpr, 3 * s);
        ctx.fillStyle = '#35e0ff'; ctx.strokeStyle = '#04353d'; ctx.lineWidth = Math.max(1, dpr);
        ctx.fillRect(dx, dy, sz, sz); ctx.strokeRect(dx, dy, sz, sz);
      }
    });
    st.spawns.forEach((sp) => {
      const cx = ox + (sp.x + 0.5) * s, cy = oy + (sp.y + 0.5) * s, r = Math.max(10 * dpr, s * 2.2);
      ctx.fillStyle = G.TEAM_COLORS[sp.team] + 'dd'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * dpr;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#111'; ctx.font = '700 ' + Math.round(r * 1.05) + 'px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(sp.team + 1), cx, cy + dpr);
    });
    ctx.strokeStyle = 'rgba(232,121,58,.9)'; ctx.lineWidth = 2 * dpr; ctx.strokeRect(ox, oy, W * s, H * s);
  }

  /* ------------------------------------------------------------- pointer input */
  const pts = new Map();
  let drag = null, pinch = null, moved = false, startPos = null;
  const pos = (e) => { const r = Editor.cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const cellAt = (mx, my) => {
    const v = Editor.view, cv = Editor.cv;
    return [Math.floor(v.cx + (mx - cv.clientWidth / 2) / v.s), Math.floor(v.cy + (my - cv.clientHeight / 2) / v.s)];
  };
  function pinchState() {
    const a = Array.from(pts.values());
    return { d: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1, mx: (a[0].x + a[1].x) / 2, my: (a[0].y + a[1].y) / 2 };
  }
  function bindPointer() {
    const cv = Editor.cv;
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      const p = pos(e); pts.set(e.pointerId, p);
      if (pts.size === 1) { drag = { x: p.x, y: p.y, cx: Editor.view.cx, cy: Editor.view.cy }; startPos = p; moved = false; }
      else if (pts.size === 2) { pinch = pinchState(); drag = null; moved = true; }
    });
    cv.addEventListener('pointermove', (e) => {
      const p = pos(e);
      if (!pts.has(e.pointerId)) { if (Editor.st) info(cellAt(p.x, p.y)); return; }
      pts.set(e.pointerId, p);
      if (pinch && pts.size === 2) { const s = pinchState(); zoomAt(s.mx, s.my, s.d / pinch.d); pinch = s; Editor.redraw(); }
      else if (drag && pts.size === 1) {
        if (Math.hypot(p.x - startPos.x, p.y - startPos.y) > 6) moved = true;
        if (moved) { Editor.view.cx = drag.cx - (p.x - drag.x) / Editor.view.s; Editor.view.cy = drag.cy - (p.y - drag.y) / Editor.view.s; Editor.redraw(); }
      }
    });
    const up = (e) => {
      const had = pts.has(e.pointerId), p = pos(e);
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (had && pts.size === 0 && !moved && e.type === 'pointerup') tap(p.x, p.y);
      if (pts.size === 0) drag = null;
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('wheel', (e) => { e.preventDefault(); const p = pos(e); zoomAt(p.x, p.y, e.deltaY < 0 ? 1.18 : 1 / 1.18); Editor.redraw(); }, { passive: false });
  }

  function info(c) {
    const st = Editor.st, x = c[0], y = c[1];
    if (!Editor.hooks.onInfo) return;
    if (x < 0 || y < 0 || x >= st.W || y >= st.H) { Editor.hooks.onInfo('Outside the map'); return; }
    const i = y * st.W + x;
    Editor.hooks.onInfo('x ' + x + '  y ' + y + '   ' + G.CLS_NAMES[st.cls[i]] + '   ' + Math.round(st.elev[i]) + ' m' + (st.trees[i] ? '   tree' : ''));
  }
  const toast = (m, k) => { if (Editor.hooks.onToast) Editor.hooks.onToast(m, k); };

  /* --------------------------------------------------------------- editing tools */
  async function tap(mx, my) {
    const st = Editor.st; if (!st) return;
    const c = cellAt(mx, my), x = c[0], y = c[1], W = st.W, H = st.H;
    info(c);
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = y * W + x, tool = Editor.tool;
    if (tool === 'spawn') {
      if (x < 5 || y < 5 || x >= W - 5 || y >= H - 5) { toast('Too close to the map edge for a base.', 'err'); return; }
      if (!G.isBuildable(st.cls, W, H, x, y, 5)) {
        if (Editor.flatten) G.flatten(st, x, y, 5);
        else { toast('This spot is not buildable (water or mountain). Enable levelling or pick another place.', 'err'); return; }
      }
      G.clearTreesAround(st, x, y, 7);
      st.spawns = st.spawns.filter((s) => s.team !== Editor.team);
      st.spawns.push({ x: x, y: y, team: Editor.team });
      await Editor.retile();
    } else if (tool === 'pool') {
      const k = st.pools.findIndex((p) => Math.abs(p.x - x) <= 1 && Math.abs(p.y - y) <= 1);
      if (k >= 0) st.pools.splice(k, 1);
      else if (G.blockOK(st, x, y)) {
        st.pools = st.pools.filter((p) => Math.abs(p.x - x) > 2 || Math.abs(p.y - y) > 2);
        st.pools.push({ x: x, y: y });
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          st.trees[(y + dy) * W + x + dx] = 0;
          invalidateCellChunk(x + dx, y + dy);
        }
      } else toast('A resource needs a 3 by 3 buildable area.', 'err');
      Editor.redraw(); changed();
    } else if (tool === 'tree') {
      if (st.trees[i]) st.trees[i] = 0;
      else if (G.BUILDABLE[st.cls[i]] && st.cls[i] !== C.SAND) st.trees[i] = 1 + Math.floor(Math.random() * G.TREE_TILES.length);
      invalidateCellChunk(x, y);
      Editor.redraw(); changed();
    } else if (tool === 'erase') {
      const near = (p, r) => Math.abs(p.x - x) <= r && Math.abs(p.y - y) <= r;
      st.spawns = st.spawns.filter((p) => !near(p, 2));
      st.pools = st.pools.filter((p) => !near(p, 2));
      st.trees[i] = 0;
      invalidateCellChunk(x, y);
      Editor.redraw(); changed();
    }
  }

  Editor.setTool = (t) => { Editor.tool = t; Editor.cv.style.cursor = t === 'pan' ? 'grab' : 'crosshair'; };
  Editor.setTeam = (t) => { Editor.team = t; };

  Editor.autoPlayers = function (n, seed) {
    const st = Editor.st; if (!st) return Promise.resolve();
    st.spawns = G.autoSpawns(st, n, seed == null ? st.seed : seed);
    st.spawns.forEach((s) => { G.flatten(st, s.x, s.y, 5); G.clearTreesAround(st, s.x, s.y, 7); });
    return Editor.retile();
  };
  Editor.autoResources = function (n, seed) {
    const st = Editor.st; if (!st) return;
    st.pools = G.autoPools(st, st.spawns, n, seed == null ? st.seed + Math.floor(Math.random() * 1000) : seed);
    Editor.redraw(); changed();
  };
  Editor.clearPlayers = function () { if (Editor.st) { Editor.st.spawns = []; Editor.redraw(); changed(); } };
  Editor.clearResources = function () { if (Editor.st) { Editor.st.pools = []; Editor.redraw(); changed(); } };

  /** Everything the export worker needs. */
  Editor.getExportState = function () {
    const st = Editor.st;
    return { W: st.W, H: st.H, cls: st.cls, ground: st.ground, trees: st.trees, spawns: st.spawns, pools: st.pools, regIds: st.reg.ids.slice() };
  };

  Editor.previewPng = function () {
    const st = Editor.st;
    return new Promise((resolve) => {
      const k = Math.max(1, Math.min(4, Math.floor(2000 / Math.max(st.W, st.H))));
      const c = document.createElement('canvas');
      c.width = st.W * k; c.height = st.H * k;
      const x = c.getContext('2d');
      x.imageSmoothingEnabled = false;
      x.drawImage(Editor.mini, 0, 0, c.width, c.height);
      st.pools.forEach((p) => { x.fillStyle = '#35e0ff'; x.fillRect((p.x - 1) * k, (p.y - 1) * k, 3 * k, 3 * k); });
      st.spawns.forEach((s) => {
        x.fillStyle = G.TEAM_COLORS[s.team]; x.strokeStyle = '#fff'; x.lineWidth = Math.max(1, k / 2);
        x.beginPath(); x.arc((s.x + 0.5) * k, (s.y + 0.5) * k, Math.max(4, 2.5 * k), 0, Math.PI * 2); x.fill(); x.stroke();
      });
      c.toBlob(resolve, 'image/png');
    });
  };

  window.Editor = Editor;
})();
