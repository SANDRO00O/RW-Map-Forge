/* RW Map Forge - application shell */
(function () {
  'use strict';
  const G = window.RWGen, UI = window.UI, Editor = window.Editor;
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /* ------------------------------------------------------------------ state */
  const DEFAULTS = {
    lat: 46.55, lon: 7.98, W: 256, H: 256, mpt: 30, layer: 0,
    osmWater: true, osmLand: true, osmRoads: false,
    seaLevel: 0, mountPct: 12, stonePct: 8, smooth: 1, base: 'auto', snowShift: 0, beach: true, urbanDirt: true,
    treeDensity: 45, players: 2, neutral: 10, seed: 1, autoPlace: true,
    name: 'Real_World_Map', fmt: 'gzip', tsMode: 'external', extPrefix: '../../steamapps/common/Rusted Warfare/mods/maps/',
    builders: true, mapInfo: false, hillshade: true, flatSpawn: true,
  };
  const S = Object.assign({}, DEFAULTS);
  const STORE = 'rwforge.v1';
  let template = null, hasMap = false, mapCtl = null, generating = null, exporter = null;

  function load() {
    try {
      const o = JSON.parse(localStorage.getItem(STORE) || '{}');
      Object.keys(DEFAULTS).forEach((k) => { if (k in o && typeof o[k] === typeof DEFAULTS[k]) S[k] = o[k]; });
    } catch (_) { /* storage unavailable */ }
    S.lat = clamp(S.lat, -85, 85);
    S.lon = ((S.lon + 180) % 360 + 360) % 360 - 180;
    S.W = clamp(Math.round(S.W), 40, 1000); S.H = clamp(Math.round(S.H), 40, 1000);
  }
  function save() { try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (_) { /* ignore */ } }

  /* ------------------------------------------------------------------ views */
  const VIEWS = ['location', 'settings', 'editor'];
  function showView(name) {
    if (name === 'editor' && !hasMap) return;
    VIEWS.forEach((v) => $('view-' + v).classList.toggle('is-active', v === name));
    document.querySelectorAll('#steps .step').forEach((b) => {
      const i = VIEWS.indexOf(b.dataset.view), cur = VIEWS.indexOf(name);
      b.classList.toggle('is-active', i === cur);
      b.classList.toggle('is-done', i < cur || (i === 2 && hasMap && cur !== 2));
    });
    if (name === 'editor') requestAnimationFrame(() => { Editor.fit(); });
  }
  document.querySelectorAll('#steps .step').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

  /* --------------------------------------------------------------- location */
  const LAYERS = [
    { id: 'streets', name: 'Streets', url: 'https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png?key=cb1_4uds_1_7172afb4fccf36ee843ce377', maxZoom: 18, bg: '#e6e2da', attribution: 'Map data: OpenStreetMap contributors. Style: CARTO' },
    { id: 'dark', name: 'Dark', url: 'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png?key=cb1_4uds_1_7172afb4fccf36ee843ce377', subdomains: ['a', 'b', 'c', 'd'], maxZoom: 18, bg: '#0b0e13', attribution: 'Map data: OpenStreetMap contributors. Style: CARTO' },
    { id: 'satellite', name: 'Satellite', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', maxZoom: 18, bg: '#0b0e13', attribution: 'Imagery: Esri, Maxar, Earthstar Geographics' },
  ];

  function geo() { return G.makeGeo(S.lat, S.lon, S.W, S.H, S.mpt); }

  function drawSelection(ctx, m) {
    const b = geo().bbox(), a = m.project(b.n, b.w), c = m.project(b.s, b.e);
    const x = a.x, y = a.y, w = c.x - a.x, h = c.y - a.y;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, m.w, m.h); ctx.rect(x, y, w, h);
    ctx.fillStyle = 'rgba(7,9,13,.38)'; ctx.fill('evenodd');
    ctx.fillStyle = 'rgba(232,121,58,.10)'; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#ff9a5c'; ctx.lineWidth = 2; ctx.setLineDash([8, 6]); ctx.strokeRect(x, y, w, h); ctx.setLineDash([]);
    const L = Math.min(18, Math.abs(w) / 3, Math.abs(h) / 3);
    ctx.lineWidth = 3.5; ctx.lineCap = 'round'; ctx.beginPath();
    [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]].forEach((k) => {
      ctx.moveTo(k[0] + k[2] * L, k[1]); ctx.lineTo(k[0], k[1]); ctx.lineTo(k[0], k[1] + k[3] * L);
    });
    ctx.stroke();
    const cx = x + w / 2, cy = y + h / 2;
    ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#ff9a5c'; ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill();
    if (w > 130 && h > 60) {
      const t = S.W + ' x ' + S.H + ' tiles', tw = ctx.measureText(t).width;
      ctx.font = '600 12px Inter, system-ui, sans-serif';
      const pw = ctx.measureText(t).width + 18;
      ctx.fillStyle = 'rgba(14,17,22,.88)'; ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x + 10, y + 10, pw, 24, 8); else ctx.rect(x + 10, y + 10, pw, 24);
      ctx.fill(); ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(t, x + 19, y + 22);
      void tw;
    }
    ctx.restore();
  }

  function updateExtent() {
    const kmW = S.W * S.mpt / 1000, kmH = S.H * S.mpt / 1000, tiles = S.W * S.H;
    let html = '<b>' + kmW.toFixed(1) + ' x ' + kmH.toFixed(1) + ' km</b> at ' + S.mpt + ' m per tile, ' + tiles.toLocaleString('en') + ' tiles';
    if (tiles > 400000) html += ' <span class="warn">Large map: needs more memory.</span>';
    else if (Math.max(kmW, kmH) > 60) html += ' <span class="warn">Wide area: OpenStreetMap downloads can be slow.</span>';
    $('extent').innerHTML = html;
  }
  function fitSelection() {
    if (!mapCtl) return;
    const host = $('map').getBoundingClientRect(), dock = $('dock').getBoundingClientRect();
    const bottom = dock.height ? Math.max(0, host.bottom - dock.top) + 10 : 0;
    mapCtl.fitBounds(geo().bbox(), 40, { top: window.innerWidth <= 640 ? 70 : 12, bottom: bottom });
  }

  function setCenter(lat, lon, o) {
    o = o || {};
    S.lat = clamp(lat, -85, 85);
    S.lon = ((lon + 180) % 360 + 360) % 360 - 180;
    $('inLat').value = S.lat.toFixed(5); $('inLon').value = S.lon.toFixed(5);
    if (mapCtl) {
      if (o.pan) { mapCtl.setView(S.lat, S.lon, o.zoom); if (o.fit) fitSelection(); }
      mapCtl.requestDraw();
    }
    save();
  }

  function initLocation() {
    mapCtl = new window.SlippyMap($('map'), {
      layers: LAYERS, layerIndex: clamp(S.layer, 0, LAYERS.length - 1), lat: S.lat, lon: S.lon, zoom: 9,
      overlay: drawSelection, onTap: (lat, lon) => setCenter(lat, lon),
    });
    mapCtl.maxZoom = mapCtl.layer.maxZoom;
    $('mapAttrib').textContent = mapCtl.layer.attribution;
    $('inLat').value = S.lat.toFixed(5); $('inLon').value = S.lon.toFixed(5);
    requestAnimationFrame(fitSelection);

    const num = (id, lo, hi) => { const v = parseFloat($(id).value.replace(',', '.')); return isFinite(v) ? clamp(v, lo, hi) : null; };
    const coordChange = () => {
      const la = num('inLat', -85, 85), lo = num('inLon', -1e5, 1e5);   // longitude is wrapped into -180..180 by setCenter
      setCenter(la == null ? S.lat : la, lo == null ? S.lon : lo, { pan: true, zoom: mapCtl.zoom });
    };
    $('inLat').addEventListener('change', coordChange); $('inLon').addEventListener('change', coordChange);
    [$('inLat'), $('inLon')].forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') i.blur(); }));

    const afterSize = (fit) => { updateExtent(); mapCtl.requestDraw(); if (fit) fitSelection(); save(); };
    const seg = UI.segmented($('segPreset'), {
      options: [{ value: 128, label: 'S' }, { value: 256, label: 'M' }, { value: 400, label: 'L' }, { value: 600, label: 'XL' }],
      value: S.W === S.H ? S.W : null,
      onChange: (v) => { S.W = S.H = v; stW.set(v); stH.set(v); afterSize(true); },
    });
    const syncPreset = () => seg.set(S.W === S.H && [128, 256, 400, 600].includes(S.W) ? S.W : null);
    const stW = UI.stepper($('stW'), { min: 40, max: 1000, step: 8, value: S.W, unit: 'W', label: 'Width in tiles', onChange: (v) => { S.W = v; syncPreset(); afterSize(false); } });
    const stH = UI.stepper($('stH'), { min: 40, max: 1000, step: 8, value: S.H, unit: 'H', label: 'Height in tiles', onChange: (v) => { S.H = v; syncPreset(); afterSize(false); } });
    const scales = [[10, 'Very fine'], [15, 'Fine'], [20, 'Detailed'], [30, 'Balanced'], [50, 'Wide'], [75, 'Wider'], [100, 'Regional'], [150, 'Large region'], [250, 'Country scale'], [500, 'Continental']];
    UI.select($('selScale'), {
      label: 'Meters per tile', value: S.mpt,
      options: scales.map((s) => ({ value: s[0], label: s[0] + ' m per tile', hint: s[1] })),
      onChange: (v) => { S.mpt = v; afterSize(true); },
    });
    updateExtent();

    const dock = $('dock'), toggle = $('dockToggle');
    const setCollapsed = (c) => { dock.classList.toggle('is-collapsed', c); toggle.setAttribute('aria-expanded', c ? 'false' : 'true'); setTimeout(fitSelection, 30); };
    toggle.addEventListener('click', () => setCollapsed(!dock.classList.contains('is-collapsed')));
    if (window.innerWidth <= 640) { dock.classList.add('is-collapsed'); }

    $('mapZoomIn').addEventListener('click', () => mapCtl.zoomBy(1));
    $('mapZoomOut').addEventListener('click', () => mapCtl.zoomBy(-1));
    $('btnLayers').addEventListener('click', () => {
      UI.listPopover($('btnLayers'), LAYERS.map((l, i) => ({ value: i, label: l.name })), mapCtl.layerIndex, (i) => {
        mapCtl.setLayer(i); S.layer = i; $('mapAttrib').textContent = mapCtl.layer.attribution; save();
      }, { matchWidth: false });
    });
    $('btnLocate').addEventListener('click', () => {
      if (!navigator.geolocation) { UI.toast('Geolocation is not available in this browser.', 'err'); return; }
      navigator.geolocation.getCurrentPosition(
        (p) => { setCenter(p.coords.latitude, p.coords.longitude, { pan: true, zoom: 11 }); },
        () => UI.toast('Could not read your location. Check the browser permission.', 'err'),
        { timeout: 10000 });
    });
    $('btnToSettings').addEventListener('click', () => showView('settings'));
    initSearch();
  }

  /* ----------------------------------------------------------------- search */
  function initSearch() {
    const input = $('searchInput'), box = $('searchResults'), clear = $('searchClear');
    let timer = null, seq = 0;
    const hide = () => { box.hidden = true; };
    const show = (html) => { box.innerHTML = html; box.hidden = false; };
    async function run(q) {
      const my = ++seq;
      show('<div class="empty">Searching...</div>');
      try {
        const r = await fetch('/api/geocode?q=' + encodeURIComponent(q));
        const j = await r.json();
        if (my !== seq) return;
        if (!r.ok) throw new Error(j.error || 'Search failed');
        if (!j.results.length) { show('<div class="empty">No places found.</div>'); return; }
        box.innerHTML = '';
        j.results.forEach((p) => {
          const parts = p.name.split(','), title = parts.shift().trim(), rest = parts.join(',').trim();
          const b = UI.el('button', 'pop-item', UI.icon('pin') + '<span>' + UI.esc(title) + (rest ? '<small>' + UI.esc(rest) + '</small>' : '') + '</span>');
          b.type = 'button';
          b.addEventListener('click', () => { input.value = title; hide(); setCenter(p.lat, p.lon, { pan: true, zoom: 11, fit: true }); });
          box.appendChild(b);
        });
        box.hidden = false;
      } catch (e) { if (my === seq) show('<div class="empty">' + UI.esc(e.message) + '</div>'); }
    }
    input.addEventListener('input', () => {
      const q = input.value.trim();
      clear.hidden = !q;
      clearTimeout(timer);
      if (q.length < 2) { seq++; hide(); return; }
      timer = setTimeout(() => run(q), 380);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { const f = box.querySelector('button'); if (f) f.click(); else if (input.value.trim().length > 1) { clearTimeout(timer); run(input.value.trim()); } }
      else if (e.key === 'Escape') { hide(); input.blur(); }
    });
    clear.addEventListener('click', () => { input.value = ''; clear.hidden = true; hide(); input.focus(); });
    document.addEventListener('pointerdown', (e) => { if (!$('searchBox').contains(e.target)) hide(); });
  }

  /* --------------------------------------------------------------- settings */
  const ctl = {};
  const SCHEMA = [
    {
      icon: 'globe', title: 'Data sources', rows: [
        { type: 'switch', key: 'osmWater', label: 'OpenStreetMap water', hint: 'Lakes, reservoirs and rivers. Sea comes from elevation data.' },
        { type: 'switch', key: 'osmLand', label: 'OpenStreetMap land cover', hint: 'Forests, sand, bare rock, farmland and built-up areas.' },
        { type: 'switch', key: 'osmRoads', label: 'Main roads as dirt tracks', hint: 'Heavier download. Adds major roads as dirt strips.' },
      ],
    },
    {
      icon: 'mountain', title: 'Terrain', rows: [
        { type: 'slider', key: 'mountPct', label: 'Mountain share', hint: 'Share of land taken by the steepest slopes (impassable mountains).', min: 0, max: 40, step: 1, fmt: (v) => v + '%' },
        { type: 'slider', key: 'stonePct', label: 'Rocky ground share', hint: 'Moderately steep land rendered as dirt.', min: 0, max: 30, step: 1, fmt: (v) => v + '%' },
        { type: 'select', key: 'smooth', label: 'Elevation smoothing', hint: 'Higher values merge small bumps into larger shapes.', options: [{ value: 0, label: 'None' }, { value: 1, label: 'Light' }, { value: 2, label: 'Medium' }, { value: 3, label: 'Strong' }] },
        { type: 'stepper', key: 'seaLevel', label: 'Sea level', hint: 'Anything at or below this height becomes water. Lower it for polders and deltas.', min: -500, max: 500, step: 1, unit: 'm' },
      ],
    },
    {
      icon: 'drop', title: 'Ground cover', rows: [
        { type: 'select', key: 'base', label: 'Default ground', hint: 'Used where no land cover data exists.', options: [{ value: 'auto', label: 'Automatic (grass, snow near the poles)' }, { value: 'grass', label: 'Grass' }, { value: 'dirt', label: 'Dirt' }, { value: 'sand', label: 'Sand (desert)' }, { value: 'snow', label: 'Snow' }] },
        { type: 'stepper', key: 'snowShift', label: 'Snow line offset', hint: 'Raise or lower the altitude where snow starts.', min: -3000, max: 3000, step: 100, unit: 'm' },
        { type: 'switch', key: 'beach', label: 'Sandy beaches', hint: 'A sand strip along coasts and lakes.' },
        { type: 'switch', key: 'urbanDirt', label: 'Built-up areas as dirt', hint: 'Cities and industrial zones become bare ground.' },
        { type: 'slider', key: 'treeDensity', label: 'Forest tree density', hint: 'How many tiles of a forest receive a tree.', min: 0, max: 90, step: 1, fmt: (v) => v + '%' },
      ],
    },
    {
      icon: 'users', title: 'Players and resources', rows: [
        { type: 'stepper', key: 'players', label: 'Players', hint: 'Start positions to place automatically (2 to 10).', min: 2, max: 10, step: 1 },
        { type: 'stepper', key: 'neutral', label: 'Neutral resources', hint: 'Extra resource pools spread across the map.', min: 0, max: 200, step: 1 },
        { type: 'seed', key: 'seed', label: 'Random seed', hint: 'Controls forests, start positions and resource spread.' },
        { type: 'switch', key: 'autoPlace', label: 'Place players and resources automatically', hint: 'You can still move everything in the editor.' },
      ],
    },
  ];

  function buildSettings() {
    const host = $('settingsCards');
    SCHEMA.forEach((card) => {
      const el = UI.el('section', 'card');
      el.appendChild(UI.el('div', 'card-head', '<span class="badge">' + UI.icon(card.icon) + '</span><h2>' + UI.esc(card.title) + '</h2>'));
      card.rows.forEach((r) => {
        const row = UI.el('div', 'set');
        const slot = UI.el('div');
        if (r.type === 'switch') {
          row.appendChild(UI.el('div', 'two'));
          const two = row.firstChild;
          two.appendChild(UI.el('span', 'name', UI.esc(r.label)));
          const b = UI.el('button', 'switch'); two.appendChild(b);
          ctl[r.key] = UI.switch(b, { value: S[r.key], label: r.label, onChange: (v) => { S[r.key] = v; save(); } });
        } else if (r.type === 'slider') {
          const head = UI.el('div', 'two'); head.appendChild(UI.el('span', 'name', UI.esc(r.label)));
          const out = UI.el('output'); head.appendChild(out); row.appendChild(head);
          row.appendChild(slot);
          ctl[r.key] = UI.slider(slot, { min: r.min, max: r.max, step: r.step, value: S[r.key], label: r.label, output: out, format: r.fmt, onChange: (v) => { S[r.key] = v; save(); } });
        } else if (r.type === 'select') {
          row.appendChild(UI.el('span', 'name', UI.esc(r.label))); row.appendChild(slot);
          ctl[r.key] = UI.select(slot, { options: r.options, value: S[r.key], label: r.label, onChange: (v) => { S[r.key] = v; save(); } });
        } else if (r.type === 'stepper') {
          row.appendChild(UI.el('span', 'name', UI.esc(r.label))); row.appendChild(slot);
          ctl[r.key] = UI.stepper(slot, { min: r.min, max: r.max, step: r.step, unit: r.unit, value: S[r.key], label: r.label, onChange: (v) => { S[r.key] = v; save(); } });
        } else if (r.type === 'seed') {
          row.appendChild(UI.el('span', 'name', UI.esc(r.label)));
          const two = UI.el('div', 'two'); const st = UI.el('div'); two.appendChild(st);
          const dice = UI.el('button', 'btn small', UI.icon('dice') + '<span>Randomize</span>'); dice.type = 'button'; two.appendChild(dice);
          row.appendChild(two);
          ctl[r.key] = UI.stepper(st, { min: 0, max: 999999, step: 1, value: S[r.key], label: r.label, onChange: (v) => { S[r.key] = v; save(); } });
          dice.addEventListener('click', () => { S.seed = Math.floor(Math.random() * 999999); ctl.seed.set(S.seed); save(); });
        }
        if (r.hint) row.appendChild(UI.el('p', 'hint', UI.esc(r.hint)));
        el.appendChild(row);
      });
      host.appendChild(el);
    });
    $('btnBackLocation').addEventListener('click', () => showView('location'));
    $('btnGenerate').addEventListener('click', generate);
  }

  /* --------------------------------------------------------------- progress */
  const STEPS = [['elevation', 'Elevation data'], ['osm', 'Water and land cover'], ['terrain', 'Terrain and vegetation'], ['players', 'Players and resources']];
  const Progress = {
    idx: -1,
    open(onCancel) {
      $('progress').hidden = false;
      $('progTitle').textContent = 'Generating map';
      $('progLog').innerHTML = ''; $('progBar').style.width = '0%';
      Progress.idx = -1;
      $('progSteps').innerHTML = STEPS.map((s, i) => '<li data-i="' + i + '"><span class="dot"></span><span>' + UI.esc(s[1]) + '</span></li>').join('');
      const actions = $('progActions'); actions.innerHTML = '';
      const cancel = UI.el('button', 'btn ghost', '<span>Cancel</span>'); cancel.type = 'button';
      cancel.addEventListener('click', onCancel); actions.appendChild(cancel);
      Progress.mark();
    },
    mark(failAt) {
      document.querySelectorAll('#progSteps li').forEach((li) => {
        const i = +li.dataset.i, dot = li.firstChild;
        li.className = i < Progress.idx ? 'is-done' : i === Progress.idx ? 'is-now' : '';
        dot.innerHTML = i < Progress.idx ? UI.icon('check') : i === Progress.idx ? UI.icon('spinner', 'spin') : '';
        if (failAt === i) { li.className = 'is-fail'; dot.innerHTML = UI.icon('x'); }
      });
    },
    update(step, msg, pct) {
      const i = STEPS.findIndex((s) => s[0] === step);
      if (i >= 0 && i !== Progress.idx) { Progress.idx = i; Progress.mark(); }
      if (step === 'done') { Progress.idx = STEPS.length; Progress.mark(); }
      if (typeof pct === 'number') $('progBar').style.width = Math.round(pct * 100) + '%';
      Progress.log(msg);
    },
    log(msg, cls) { const d = UI.el('div', cls || '', UI.esc(msg)); $('progLog').appendChild(d); $('progLog').scrollTop = 1e6; },
    fail(msg, code) {
      Progress.mark(Math.max(0, Progress.idx));
      $('progTitle').textContent = 'Generation stopped';
      Progress.log(msg, 'bad');
      const actions = $('progActions'); actions.innerHTML = '';
      const back = UI.el('button', 'btn primary', '<span>Back to ' + (code === 'ocean' ? 'location' : 'settings') + '</span>'); back.type = 'button';
      back.addEventListener('click', () => { Progress.close(); showView(code === 'ocean' ? 'location' : 'settings'); });
      actions.appendChild(back);
    },
    close() { $('progress').hidden = true; },
  };

  /* --------------------------------------------------------------- generate */
  function genParams() {
    return {
      lat: S.lat, lon: S.lon, W: S.W, H: S.H, mpt: S.mpt, seed: S.seed, seaLevel: S.seaLevel,
      osm: { water: S.osmWater, land: S.osmLand, roads: S.osmRoads },
      terrain: { seaLevel: S.seaLevel, mountPct: S.mountPct, stonePct: S.stonePct, smooth: S.smooth, base: S.base, snowShift: S.snowShift, beach: S.beach, urbanDirt: S.urbanDirt, roads: S.osmRoads, seed: S.seed },
      treeDensity: S.treeDensity / 100, autoPlace: S.autoPlace, players: S.players, neutral: S.neutral,
    };
  }

  function generate() {
    if (generating) return;
    const w = new Worker('/js/pipeline.worker.js');
    generating = w;
    $('btnGenerate').disabled = true;
    Progress.open(() => { w.terminate(); generating = null; $('btnGenerate').disabled = false; Progress.close(); });
    w.onmessage = async (e) => {
      const m = e.data;
      if (m.type === 'progress') Progress.update(m.step, m.msg, m.pct);
      else if (m.type === 'error') { w.terminate(); generating = null; $('btnGenerate').disabled = false; Progress.fail(m.message, m.code); }
      else if (m.type === 'result') {
        w.terminate(); generating = null; $('btnGenerate').disabled = false;
        Progress.update('done', 'Building preview', 1);
        Editor.setState({ W: m.W, H: m.H, cls: m.cls, shade: m.shade, treeCand: m.treeCand, trees: m.trees, elev: m.elev, spawns: m.spawns, pools: m.pools, seed: m.seed });
        await Editor.retile();
        hasMap = true;
        $('steps').querySelector('[data-view=editor]').disabled = false;
        Progress.close();
        showView('editor');
        renderTeams(); syncPanel();
        UI.toast('Map generated. Place players and resources, then export.', 'ok');
      }
    };
    w.onerror = (e) => { w.terminate(); generating = null; $('btnGenerate').disabled = false; Progress.fail('The worker crashed: ' + (e.message || 'unknown error'), 'worker'); };
    w.postMessage({ type: 'generate', params: genParams() });
  }

  /* ----------------------------------------------------------------- editor */
  function renderTeams() {
    const box = $('teams'), sum = Editor.summary(), has = new Set(sum.teams || []);
    box.innerHTML = '';
    for (let t = 0; t < 10; t++) {
      const b = UI.el('button', 'team' + (has.has(t) ? ' has' : '') + (t === Editor.team ? ' is-on' : ''), String(t + 1));
      b.type = 'button'; b.style.background = G.TEAM_COLORS[t];
      b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', t === Editor.team ? 'true' : 'false'); b.setAttribute('aria-label', 'Player ' + (t + 1));
      b.addEventListener('click', () => { Editor.setTeam(t); setTool('spawn'); renderTeams(); });
      box.appendChild(b);
    }
  }
  function syncPanel(sum) {
    sum = sum || Editor.summary();
    $('summary').textContent = sum.W + ' x ' + sum.H + ' tiles  |  ' + sum.players + ' players  |  ' + sum.pools + ' resources  |  ' + sum.trees.toLocaleString('en') + ' trees';
    renderTeams();
  }
  function setTool(t) {
    Editor.setTool(t);
    document.querySelectorAll('#tools .tool-btn').forEach((b) => b.classList.toggle('is-on', b.dataset.tool === t));
  }

  function initEditor() {
    Editor.init({
      canvas: $('cv'), catalog: catalog,
      hooks: { onChange: syncPanel, onInfo: (t) => { $('cellInfo').textContent = t; }, onToast: UI.toast },
    });
    document.querySelectorAll('#tools .tool-btn').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
    $('edZoomIn').addEventListener('click', () => Editor.zoom(1.4));
    $('edZoomOut').addEventListener('click', () => Editor.zoom(1 / 1.4));
    $('edFit').addEventListener('click', () => Editor.fit());
    const panel = $('panel');
    $('btnPanel').addEventListener('click', () => panel.classList.add('is-open'));
    $('btnPanelClose').addEventListener('click', () => panel.classList.remove('is-open'));
    UI.stepper($('stPlayers'), { min: 2, max: 10, step: 1, value: S.players, label: 'Players', onChange: (v) => { S.players = v; ctl.players && ctl.players.set(v); save(); } });
    UI.stepper($('stNeutral'), { min: 0, max: 200, step: 1, value: S.neutral, label: 'Neutral resources', onChange: (v) => { S.neutral = v; ctl.neutral && ctl.neutral.set(v); save(); } });
    $('btnAutoPlayers').addEventListener('click', async () => { await Editor.autoPlayers(S.players, S.seed + Math.floor(Math.random() * 1000)); });
    $('btnAutoPools').addEventListener('click', () => Editor.autoResources(S.neutral));
    $('btnClearPlayers').addEventListener('click', () => Editor.clearPlayers());
    $('btnClearPools').addEventListener('click', () => Editor.clearResources());
    UI.switch($('swHill'), { value: S.hillshade, label: 'Hillshade', onChange: (v) => { S.hillshade = v; Editor.setHillshade(v); save(); } });
    UI.switch($('swFlat'), { value: S.flatSpawn, label: 'Level ground around players', onChange: (v) => { S.flatSpawn = v; Editor.setFlatten(v); save(); } });
    Editor.setHillshade(S.hillshade); Editor.setFlatten(S.flatSpawn);
    const legend = $('legend');
    [3, 4, 5, 7, 8, 2].forEach((i) => {
      const item = UI.el('span'), sw = UI.el('i');
      sw.style.background = G.CLS_COLORS[i];
      item.append(sw, document.createTextNode(G.CLS_NAMES[i]));
      legend.appendChild(item);
    });
    $('btnEditSettings').addEventListener('click', () => showView('settings'));
    $('btnExport').addEventListener('click', openExport);

    document.addEventListener('keydown', (e) => {
      if (!$('view-editor').classList.contains('is-active') || document.querySelector('.overlay') || /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
      const map = { v: 'pan', p: 'spawn', r: 'pool', t: 'tree', e: 'erase' };
      const k = e.key.toLowerCase();
      if (map[k]) setTool(map[k]);
      else if (k === 'f') Editor.fit();
      else if (k === '+' || k === '=') Editor.zoom(1.4);
      else if (k === '-') Editor.zoom(1 / 1.4);
    });
  }

  /* ----------------------------------------------------------------- export */
  function parseTemplate(file) {
    return file.text().then((txt) => {
      const doc = new DOMParser().parseFromString(txt, 'application/xml');
      if (doc.querySelector('parsererror')) throw new Error('That file is not valid XML.');
      const sets = [];
      doc.querySelectorAll('map > tileset').forEach((t) => {
        const im = t.querySelector('image'), src = t.getAttribute('source') || '', imgSrc = im ? im.getAttribute('source') || '' : '';
        const tw = +t.getAttribute('tilewidth') || 20, th = +t.getAttribute('tileheight') || 20;
        let count = +t.getAttribute('tilecount') || 0;
        if (!count && im && +im.getAttribute('width')) count = Math.floor(+im.getAttribute('width') / tw) * Math.floor(+im.getAttribute('height') / th);
        sets.push({
          gid: +t.getAttribute('firstgid') || 1, count: count || 400,
          img: G.NORM(imgSrc.replace(/^.*[\\/]/, '').replace(/\.[a-z]+$/i, '')),
          src: G.NORM(src.replace(/^.*[\\/]/, '').replace(/\.tsx$/i, '')),
          name: G.NORM(t.getAttribute('name')),
          xml: ' ' + new XMLSerializer().serializeToString(t).replace(/ xmlns="[^"]*"/, ''),
        });
      });
      if (!sets.length) throw new Error('No tilesets were found in that map.');
      return sets;
    });
  }

  function fileName() {
    const base = (S.name || 'map').trim().replace(/\s+/g, '_').replace(/[\\/:*?"<>|\[\]()]/g, '') || 'map';
    return '[p' + Math.max(2, Editor.summary().players) + ']' + base + '.tmx';
  }
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }

  function runExport(btn) {
    return new Promise((resolve, reject) => {
      const state = Editor.getExportState();
      const ids = state.regIds.concat(['misc', 'units']), sub = {};
      ids.forEach((id) => { sub[id] = catalog[id]; });
      const opts = { fmt: S.fmt, tsMode: S.tsMode, extPrefix: S.extPrefix, builders: S.builders, mapInfo: S.mapInfo, template: template ? { sets: template } : null };
      if (opts.tsMode === 'template' && !template) { opts.tsMode = 'external'; UI.toast('No template map selected; using external tilesets instead.', 'info'); }
      if (!exporter) exporter = new Worker('/js/pipeline.worker.js');
      btn.disabled = true; btn.classList.add('spin');
      const done = () => { btn.disabled = false; btn.classList.remove('spin'); };
      exporter.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'exported') { done(); resolve(m); }
        else if (m.type === 'error') { done(); reject(new Error(m.message)); }
      };
      exporter.onerror = (e) => { done(); reject(new Error(e.message || 'Export worker failed')); };
      exporter.postMessage({ type: 'export', state: state, options: opts, catalog: sub });
    });
  }

  function openExport() {
    if (!hasMap) return;
    const body = UI.el('div', 'stack');
    body.innerHTML =
      '<div class="field"><span class="label">Map name</span><input class="text-input" id="exName" type="text" maxlength="60" spellcheck="false" autocomplete="off"></div>' +
      '<div class="pair"><div class="field"><span class="label">Layer data</span><div id="exFmt"></div></div><div class="field"><span class="label">Tilesets</span><div id="exTs"></div></div></div>' +
      '<div class="field" id="exPrefixRow"><span class="label">Tileset folder prefix</span><input class="text-input mono" id="exPrefix" type="text" spellcheck="false" autocomplete="off"></div>' +
      '<div class="field" id="exTplRow"><span class="label">Working map to copy tilesets from</span><div id="exTpl"></div></div>' +
      '<div class="toggle-row"><span>Builder with each command center</span><button id="exBuilders" class="switch"></button></div>' +
      '<div class="toggle-row"><span>Add Triggers / map_info layer</span><button id="exInfo" class="switch"></button></div>' +
      '<p class="note" id="exNote"></p>';
    const name = body.querySelector('#exName'), prefix = body.querySelector('#exPrefix');
    name.value = S.name; prefix.value = S.extPrefix;
    name.addEventListener('input', () => { S.name = name.value; note(); save(); });
    prefix.addEventListener('input', () => { S.extPrefix = prefix.value; save(); });
    const rows = () => {
      body.querySelector('#exPrefixRow').hidden = S.tsMode !== 'external';
      body.querySelector('#exTplRow').hidden = S.tsMode !== 'template';
    };
    const note = () => { body.querySelector('#exNote').textContent = 'File name: ' + fileName() + '. Copy it to your Rusted Warfare custom maps folder.'; };
    UI.select(body.querySelector('#exFmt'), { label: 'Layer data format', value: S.fmt, options: [{ value: 'gzip', label: 'Base64 + gzip' }, { value: 'zlib', label: 'Base64 + zlib' }, { value: 'csv', label: 'CSV (uncompressed)' }], onChange: (v) => { S.fmt = v; save(); } });
    UI.select(body.querySelector('#exTs'), { label: 'Tileset mode', value: S.tsMode, options: [{ value: 'external', label: 'External .tsx references' }, { value: 'embed', label: 'Embedded in the file' }, { value: 'template', label: 'Copy from a working map' }], onChange: (v) => { S.tsMode = v; rows(); save(); } });
    UI.filePicker(body.querySelector('#exTpl'), {
      accept: '.tmx,.xml', label: 'Choose map',
      onFile: (f) => parseTemplate(f).then((s) => { template = s; UI.toast('Read ' + s.length + ' tilesets from ' + f.name + '.', 'ok'); }).catch((e) => UI.toast(e.message, 'err')),
    });
    UI.switch(body.querySelector('#exBuilders'), { value: S.builders, label: 'Builder', onChange: (v) => { S.builders = v; save(); } });
    UI.switch(body.querySelector('#exInfo'), { value: S.mapInfo, label: 'map_info', onChange: (v) => { S.mapInfo = v; save(); } });
    rows(); note();
    UI.modal({
      title: 'Export map', lead: 'Download a Rusted Warfare .tmx file with Ground, Items and Units layers.', body: body,
      actions: [
        { label: 'Close', kind: 'ghost' },
        { label: 'Preview image', icon: 'image', keepOpen: true, onClick: async () => { download(await Editor.previewPng(), (S.name || 'map') + '_preview.png'); return false; } },
        {
          label: 'Download TMX', kind: 'primary', icon: 'download', keepOpen: true,
          onClick: (api) => {
            const btn = api.actions[2]._el;
            if (Editor.summary().players < 2) UI.toast('The map has fewer than 2 players; it may not appear as a skirmish map.', 'info');
            runExport(btn).then((m) => {
              download(new Blob([m.bytes], { type: 'application/xml' }), fileName());
              UI.toast('Exported ' + fileName() + ' (' + (m.bytes.byteLength / 1048576).toFixed(2) + ' MB).', 'ok');
            }).catch((e) => UI.toast('Export failed: ' + e.message, 'err'));
            return false;
          },
        },
      ],
    });
  }

  /* ------------------------------------------------------------------ about */
  function openAbout() {
    UI.modal({
      title: 'About RW Map Forge',
      lead: 'Turn real places into Rusted Warfare skirmish maps.',
      body:
        '<p class="note">Pick a location, choose a size and detail level, and the generator converts real elevation, water and land cover into Rusted Warfare tiles. Then place players and resources and export a .tmx map.</p>' +
        '<div><span class="label">Data sources</span><ul>' +
        '<li>Elevation: Terrain Tiles on AWS Open Data (Terrarium encoding)</li>' +
        '<li>Water and land cover: OpenStreetMap contributors (ODbL), via the Overpass API</li>' +
        '<li>Place search: Nominatim</li>' +
        '<li>Base maps: CARTO and Esri World Imagery</li></ul></div>' +
        '<p class="note">Rusted Warfare is a trademark of Corroding Games. This is an unofficial fan tool and is not affiliated with them.</p>',
      actions: [{ label: 'Close', kind: 'primary' }],
    });
  }

  /* ------------------------------------------------------------------- boot */
  let catalog = null;
  async function boot() {
    load();
    UI.initTooltips();
    $('btnAbout').addEventListener('click', openAbout);
    initLocation();
    buildSettings();
    try {
      const r = await fetch('/catalog.json');
      catalog = await r.json();
    } catch (_) {
      UI.toast('Could not load the tileset catalog. Reload the page.', 'err', 9000);
      catalog = {};
    }
    initEditor();
    window.RWForge = { S: S, Editor: Editor, showView: showView };
  }
  boot();
})();
