/* RW Map Forge - custom slippy map (canvas). Raster tiles, pan, pinch / wheel zoom, overlay drawing hook. No third-party map library. */
(function () {
  'use strict';
  const TS = 256, MAX_LAT = 85.0511;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function worldPx(lat, lon, z) {
    const n = TS * Math.pow(2, z), s = Math.sin(clamp(lat, -MAX_LAT, MAX_LAT) * Math.PI / 180);
    return { x: (lon + 180) / 360 * n, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n };
  }
  function unworld(x, y, z) {
    const n = TS * Math.pow(2, z);
    return { lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI, lon: x / n * 360 - 180 };
  }

  class SlippyMap {
    constructor(host, o) {
      this.host = host;
      this.layers = o.layers;
      this.layerIndex = o.layerIndex || 0;
      this.center = { lat: o.lat, lon: o.lon };
      this.zoom = o.zoom;
      this.minZoom = 2;
      this.maxZoom = 18;
      this.onTap = o.onTap || null;
      this.onView = o.onView || null;
      this.overlay = o.overlay || null;
      this.tiles = new Map();
      this.dirty = true;
      this.canvas = document.createElement('canvas');
      this.ctx = this.canvas.getContext('2d');
      host.appendChild(this.canvas);
      this.pointers = new Map();
      this.bind();
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(host);
      this.resize();
      const loop = () => { if (this.dirty) { this.dirty = false; this.draw(); } this.raf = requestAnimationFrame(loop); };
      loop();
    }

    get layer() { return this.layers[this.layerIndex]; }
    requestDraw() { this.dirty = true; }

    resize() {
      const dpr = window.devicePixelRatio || 1, r = this.host.getBoundingClientRect();
      this.w = Math.max(1, r.width); this.h = Math.max(1, r.height);
      this.canvas.width = Math.round(this.w * dpr); this.canvas.height = Math.round(this.h * dpr);
      this.dpr = dpr;
      this.requestDraw();
    }

    setLayer(i) { this.layerIndex = i; this.maxZoom = this.layer.maxZoom; if (this.zoom > this.maxZoom) this.zoom = this.maxZoom; this.requestDraw(); this.emitView(); }
    emitView() { if (this.onView) this.onView(this.getView()); }
    getView() { return { lat: this.center.lat, lon: this.center.lon, zoom: this.zoom }; }

    setView(lat, lon, zoom) {
      this.center = { lat: clamp(lat, -MAX_LAT, MAX_LAT), lon: ((lon + 180) % 360 + 360) % 360 - 180 };
      if (zoom != null) this.zoom = clamp(zoom, this.minZoom, Math.min(this.maxZoom, this.layer.maxZoom));
      this.requestDraw(); this.emitView();
    }

    project(lat, lon) {
      const c = worldPx(this.center.lat, this.center.lon, this.zoom), p = worldPx(lat, lon, this.zoom);
      const world = TS * Math.pow(2, this.zoom);
      let dx = p.x - c.x;
      if (dx > world / 2) dx -= world; else if (dx < -world / 2) dx += world;
      return { x: this.w / 2 + dx, y: this.h / 2 + (p.y - c.y) };
    }
    unproject(sx, sy) {
      const c = worldPx(this.center.lat, this.center.lon, this.zoom);
      const g = unworld(c.x + sx - this.w / 2, c.y + sy - this.h / 2, this.zoom);
      return { lat: clamp(g.lat, -MAX_LAT, MAX_LAT), lon: ((g.lon + 180) % 360 + 360) % 360 - 180 };
    }

    zoomAround(sx, sy, newZoom) {
      newZoom = clamp(newZoom, this.minZoom, Math.min(this.maxZoom, this.layer.maxZoom));
      if (newZoom === this.zoom) return;
      const anchor = this.unproject(sx, sy);
      this.zoom = newZoom;
      const a = worldPx(anchor.lat, anchor.lon, newZoom);
      const g = unworld(a.x - (sx - this.w / 2), a.y - (sy - this.h / 2), newZoom);
      this.center = { lat: clamp(g.lat, -MAX_LAT, MAX_LAT), lon: ((g.lon + 180) % 360 + 360) % 360 - 180 };
      this.requestDraw(); this.emitView();
    }
    zoomBy(d) { this.zoomAround(this.w / 2, this.h / 2, this.zoom + d); }

    /** Fits a lat/lon box (south, west, north, east) inside the free area of the view (inset reserves space for floating UI). */
    fitBounds(b, pad, inset) {
      pad = pad || 80; inset = inset || { top: 0, bottom: 0 };
      const availH = Math.max(80, this.h - inset.top - inset.bottom);
      for (let z = Math.min(this.maxZoom, this.layer.maxZoom); z >= this.minZoom; z -= 0.25) {
        const a = worldPx(b.n, b.w, z), c = worldPx(b.s, b.e, z);
        if (Math.abs(c.x - a.x) <= this.w - pad * 2 && Math.abs(c.y - a.y) <= availH - pad * 2) {
          const lat = (b.n + b.s) / 2, lon = (b.w + b.e) / 2;
          const cp = worldPx(lat, lon, z), shift = this.h / 2 - (inset.top + availH / 2);
          const g = unworld(cp.x, cp.y + shift, z);
          this.setView(g.lat, g.lon, z);
          return;
        }
      }
    }

    /* ---------------------------------------------------------------- tiles */
    tileUrl(layer, z, x, y) {
      const sub = layer.subdomains ? layer.subdomains[(x + y) % layer.subdomains.length] : '';
      return layer.url.replace('{s}', sub).replace('{z}', z).replace('{x}', x).replace('{y}', y);
    }
    peek(layer, z, x, y) { const e = this.tiles.get(layer.id + '/' + z + '/' + x + '/' + y); return e && e.ready ? e.img : null; }
    getTile(layer, z, x, y) {
      const key = layer.id + '/' + z + '/' + x + '/' + y;
      let e = this.tiles.get(key);
      if (e) { this.tiles.delete(key); this.tiles.set(key, e); return e.ready ? e.img : null; }
      e = { ready: false, img: new Image() };
      e.img.decoding = 'async';
      e.img.onload = () => { e.ready = true; this.requestDraw(); };
      e.img.onerror = () => { e.failed = true; };
      e.img.src = this.tileUrl(layer, z, x, y);
      this.tiles.set(key, e);
      if (this.tiles.size > 420) { let n = 0; for (const k of this.tiles.keys()) { this.tiles.delete(k); if (++n > 100) break; } }
      return null;
    }

    draw() {
      const ctx = this.ctx, layer = this.layer;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.fillStyle = layer.bg || '#0b0e13';
      ctx.fillRect(0, 0, this.w, this.h);
      const tz = clamp(Math.floor(this.zoom + 0.35), this.minZoom, layer.maxZoom);
      const scale = Math.pow(2, this.zoom - tz), size = TS * scale, n = Math.pow(2, tz);
      const c = worldPx(this.center.lat, this.center.lon, tz);
      const left = c.x - this.w / (2 * scale), top = c.y - this.h / (2 * scale);
      const tx0 = Math.floor(left / TS), tx1 = Math.floor((left + this.w / scale) / TS);
      const ty0 = Math.max(0, Math.floor(top / TS)), ty1 = Math.min(n - 1, Math.floor((top + this.h / scale) / TS));
      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          const wx = ((tx % n) + n) % n, dx = (tx * TS - left) * scale, dy = (ty * TS - top) * scale;
          const img = this.getTile(layer, tz, wx, ty);
          if (img) ctx.drawImage(img, dx, dy, size + 0.6, size + 0.6);
          else if (tz > this.minZoom) {
            const parent = this.peek(layer, tz - 1, wx >> 1, ty >> 1);
            if (parent) ctx.drawImage(parent, (wx & 1) * 128, (ty & 1) * 128, 128, 128, dx, dy, size + 0.6, size + 0.6);
          }
        }
      }
      if (this.overlay) this.overlay(ctx, this);
    }

    /* ---------------------------------------------------------- interaction */
    bind() {
      const h = this.host;
      let down = null, pinch = null, moved = false;
      const pos = (e) => { const r = h.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
      h.addEventListener('pointerdown', (e) => {
        if (e.target.closest && e.target.closest('.float, .dock, .attrib')) return;
        h.setPointerCapture(e.pointerId);
        const p = pos(e);
        this.pointers.set(e.pointerId, p);
        if (this.pointers.size === 1) { down = { x: p.x, y: p.y, c: worldPx(this.center.lat, this.center.lon, this.zoom), t: performance.now() }; moved = false; h.classList.add('is-drag'); }
        else if (this.pointers.size === 2) { pinch = this.pinchState(); moved = true; down = null; }
      });
      h.addEventListener('pointermove', (e) => {
        if (!this.pointers.has(e.pointerId)) return;
        const p = pos(e);
        this.pointers.set(e.pointerId, p);
        if (pinch && this.pointers.size === 2) {
          const s = this.pinchState();
          this.zoomAround(s.mx, s.my, this.zoom + Math.log2(s.d / pinch.d));
          pinch = s;
        } else if (down && this.pointers.size === 1) {
          if (Math.hypot(p.x - down.x, p.y - down.y) > 5) moved = true;
          if (moved) {
            const g = unworld(down.c.x - (p.x - down.x), down.c.y - (p.y - down.y), this.zoom);
            this.center = { lat: clamp(g.lat, -MAX_LAT, MAX_LAT), lon: ((g.lon + 180) % 360 + 360) % 360 - 180 };
            this.requestDraw(); this.emitView();
          }
        }
      });
      const up = (e) => {
        const had = this.pointers.has(e.pointerId), p = pos(e);
        this.pointers.delete(e.pointerId);
        if (this.pointers.size < 2) pinch = null;
        if (this.pointers.size === 0) {
          h.classList.remove('is-drag');
          if (had && down && !moved && e.type === 'pointerup' && performance.now() - down.t < 600 && this.onTap) {
            const g = this.unproject(p.x, p.y);
            this.onTap(g.lat, g.lon);
          }
          down = null;
        }
      };
      h.addEventListener('pointerup', up);
      h.addEventListener('pointercancel', up);
      h.addEventListener('wheel', (e) => {
        e.preventDefault();
        const p = pos(e), k = e.ctrlKey ? 0.012 : (e.deltaMode === 1 ? 0.06 : 0.0016);
        this.zoomAround(p.x, p.y, this.zoom - e.deltaY * k);
      }, { passive: false });
      h.addEventListener('dblclick', (e) => {
        if (e.target.closest && e.target.closest('.float, .dock')) return;
        const p = pos(e); this.zoomAround(p.x, p.y, Math.round(this.zoom) + 1);
      });
    }
    pinchState() {
      const a = Array.from(this.pointers.values());
      return { d: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1, mx: (a[0].x + a[1].x) / 2, my: (a[0].y + a[1].y) / 2 };
    }
    destroy() { cancelAnimationFrame(this.raf); this.ro.disconnect(); this.canvas.remove(); }
  }

  SlippyMap.worldPx = worldPx;
  window.SlippyMap = SlippyMap;
})();
