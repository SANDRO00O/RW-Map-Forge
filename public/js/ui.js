/* RW Map Forge - UI kit. All controls are custom components (no native select / checkbox / range / number inputs). */
(function () {
  'use strict';
  const UI = {};
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  UI.esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  UI.icon = (name, cls) => '<svg class="ic' + (cls ? ' ' + cls : '') + '" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
  UI.el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };
  const popLayer = () => document.getElementById('popovers');

  /* ------------------------------------------------------------- popover */
  function placePopover(pop, anchor, matchWidth) {
    const r = anchor.getBoundingClientRect();
    pop.style.minWidth = (matchWidth ? r.width : 180) + 'px';
    if (matchWidth) pop.style.maxWidth = Math.max(r.width, 260) + 'px';
    const h = pop.offsetHeight, w = pop.offsetWidth;
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    let left = r.left;
    if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - w - 8);
    pop.style.top = top + 'px';
    pop.style.left = left + 'px';
  }

  /** Generic list popover. items: [{value,label,hint}] ; returns {close} */
  UI.listPopover = function (anchor, items, selected, onPick, opts) {
    opts = opts || {};
    const pop = UI.el('div', 'pop');
    pop.setAttribute('role', 'listbox');
    let hi = Math.max(0, items.findIndex((i) => i.value === selected));
    const nodes = items.map((it, i) => {
      const b = UI.el('button', 'pop-item' + (it.value === selected ? ' is-sel' : ''));
      b.type = 'button';
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', it.value === selected ? 'true' : 'false');
      b.innerHTML = '<span>' + UI.esc(it.label) + (it.hint ? '<small>' + UI.esc(it.hint) + '</small>' : '') + '</span>' + (it.value === selected ? UI.icon('check') : '');
      b.addEventListener('click', () => { close(); onPick(it.value); });
      b.addEventListener('pointermove', () => setHi(i));
      pop.appendChild(b);
      return b;
    });
    function setHi(i) { hi = i; nodes.forEach((n, k) => n.classList.toggle('is-hi', k === i)); }
    function close() {
      if (!pop.isConnected) return;
      pop.remove();
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', close);
      if (opts.onClose) opts.onClose();
    }
    function outside(e) { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); }
    function key(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); anchor.focus(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setHi((hi + 1) % nodes.length); nodes[hi].scrollIntoView({ block: 'nearest' }); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((hi - 1 + nodes.length) % nodes.length); nodes[hi].scrollIntoView({ block: 'nearest' }); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const v = items[hi].value; close(); onPick(v); anchor.focus(); }
      else if (e.key === 'Tab') close();
    }
    popLayer().appendChild(pop);
    setHi(hi);
    placePopover(pop, anchor, opts.matchWidth !== false);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key, true);
    window.addEventListener('resize', close);
    return { close: close };
  };

  /* -------------------------------------------------------------- select */
  UI.select = function (host, o) {
    host.classList.add('select');
    const btn = UI.el('button', 'sel-btn');
    btn.type = 'button';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    if (o.label) btn.setAttribute('aria-label', o.label);
    host.appendChild(btn);
    let cur = o.value, handle = null;
    const render = () => {
      const it = o.options.find((x) => x.value === cur) || o.options[0];
      btn.innerHTML = '<span class="sel-label">' + UI.esc(it.label) + '</span>' + UI.icon('chevron-down', 'sel-chev');
    };
    const open = () => {
      if (handle) return;
      btn.setAttribute('aria-expanded', 'true');
      handle = UI.listPopover(btn, o.options, cur, (v) => { cur = v; render(); if (o.onChange) o.onChange(v); }, {
        onClose: () => { handle = null; btn.setAttribute('aria-expanded', 'false'); },
      });
    };
    btn.addEventListener('click', () => (handle ? handle.close() : open()));
    btn.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); } });
    render();
    return { get: () => cur, set: (v) => { cur = v; render(); } };
  };

  /* -------------------------------------------------------------- switch */
  UI.switch = function (btn, o) {
    btn.type = 'button';
    btn.setAttribute('role', 'switch');
    if (o.label) btn.setAttribute('aria-label', o.label);
    let on = !!o.value;
    const render = () => btn.setAttribute('aria-checked', on ? 'true' : 'false');
    btn.addEventListener('click', () => { on = !on; render(); if (o.onChange) o.onChange(on); });
    render();
    return { get: () => on, set: (v) => { on = !!v; render(); } };
  };

  /* -------------------------------------------------------------- slider */
  UI.slider = function (host, o) {
    host.classList.add('slider');
    host.tabIndex = 0;
    host.setAttribute('role', 'slider');
    if (o.label) host.setAttribute('aria-label', o.label);
    host.innerHTML = '<div class="slider-track"></div><div class="slider-fill"></div><div class="slider-thumb"></div>';
    const fill = host.querySelector('.slider-fill'), thumb = host.querySelector('.slider-thumb');
    const min = o.min, max = o.max, step = o.step || 1;
    let val = clamp(o.value, min, max);
    const render = () => {
      const p = (val - min) / (max - min) * 100;
      fill.style.width = p + '%';
      thumb.style.left = p + '%';
      host.setAttribute('aria-valuemin', min); host.setAttribute('aria-valuemax', max); host.setAttribute('aria-valuenow', val);
      if (o.output) o.output.textContent = o.format ? o.format(val) : String(val);
    };
    const setVal = (v, fire) => {
      v = clamp(Math.round(v / step) * step, min, max);
      if (v === val && fire !== 'force') return;
      val = v; render();
      if (fire && o.onChange) o.onChange(val);
    };
    const fromEvent = (e) => {
      const r = host.getBoundingClientRect();
      return min + clamp((e.clientX - r.left - 10) / (r.width - 20), 0, 1) * (max - min);
    };
    host.addEventListener('pointerdown', (e) => { host.setPointerCapture(e.pointerId); host.classList.add('is-drag'); setVal(fromEvent(e), true); host.focus(); });
    host.addEventListener('pointermove', (e) => { if (host.classList.contains('is-drag')) setVal(fromEvent(e), true); });
    const end = () => host.classList.remove('is-drag');
    host.addEventListener('pointerup', end); host.addEventListener('pointercancel', end);
    host.addEventListener('keydown', (e) => {
      const k = e.key; let d = 0;
      if (k === 'ArrowRight' || k === 'ArrowUp') d = step; else if (k === 'ArrowLeft' || k === 'ArrowDown') d = -step;
      else if (k === 'PageUp') d = step * 10; else if (k === 'PageDown') d = -step * 10;
      else if (k === 'Home') { setVal(min, true); e.preventDefault(); return; } else if (k === 'End') { setVal(max, true); e.preventDefault(); return; }
      if (d) { e.preventDefault(); setVal(val + d, true); }
    });
    render();
    return { get: () => val, set: (v) => { val = clamp(v, min, max); render(); } };
  };

  /* ------------------------------------------------------------- stepper */
  UI.stepper = function (host, o) {
    host.classList.add('stepper');
    const dec = UI.el('button', null, UI.icon('minus')), inc = UI.el('button', null, UI.icon('plus'));
    dec.type = inc.type = 'button';
    dec.tabIndex = inc.tabIndex = -1;
    dec.setAttribute('aria-label', 'Decrease'); inc.setAttribute('aria-label', 'Increase');
    const input = UI.el('input');
    input.type = 'text'; input.inputMode = o.decimals ? 'decimal' : 'numeric'; input.autocomplete = 'off'; input.spellcheck = false;
    if (o.label) input.setAttribute('aria-label', o.label);
    host.append(dec, input);
    if (o.unit) host.appendChild(UI.el('span', 'unit', UI.esc(o.unit)));
    host.appendChild(inc);
    const step = o.step || 1, dp = o.decimals || 0;
    let val = o.value;
    const fmt = (v) => (dp ? v.toFixed(dp) : String(Math.round(v)));
    const norm = (v) => { v = Math.round(v / step) * step; return clamp(+v.toFixed(dp + 2), o.min, o.max); };
    const render = () => { input.value = fmt(val); };
    const commit = (v, fire) => {
      if (!isFinite(v)) v = val;
      v = norm(v);
      const changed = v !== val;
      val = v; render();
      if (changed && fire !== false && o.onChange) o.onChange(val);
    };
    const bump = (dir) => commit(val + dir * step);
    let timer = null;
    const hold = (btn, dir) => {
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault(); bump(dir);
        let delay = 380;
        const tick = () => { bump(dir); delay = Math.max(40, delay * 0.82); timer = setTimeout(tick, delay); };
        timer = setTimeout(tick, delay);
      });
      ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => btn.addEventListener(ev, () => { clearTimeout(timer); }));
    };
    hold(dec, -1); hold(inc, 1);
    input.addEventListener('change', () => commit(parseFloat(input.value.replace(',', '.'))));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp') { e.preventDefault(); bump(1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); bump(-1); }
      else if (e.key === 'Enter') { commit(parseFloat(input.value.replace(',', '.'))); input.blur(); }
    });
    input.addEventListener('focus', () => input.select());
    render();
    return { get: () => val, set: (v) => { val = norm(v); render(); } };
  };

  /* ----------------------------------------------------------- segmented */
  UI.segmented = function (host, o) {
    host.classList.add('segmented');
    host.setAttribute('role', 'group');
    let cur = o.value;
    const btns = o.options.map((opt) => {
      const b = UI.el('button', null, UI.esc(opt.label));
      b.type = 'button';
      b.addEventListener('click', () => { cur = opt.value; paint(); if (o.onChange) o.onChange(cur); });
      host.appendChild(b);
      return b;
    });
    const paint = () => btns.forEach((b, i) => { const on = o.options[i].value === cur; b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
    paint();
    return { get: () => cur, set: (v) => { cur = v; paint(); } };
  };

  /* ---------------------------------------------------------- file picker */
  UI.filePicker = function (host, o) {
    host.classList.add('file-pick');
    const input = UI.el('input');
    input.type = 'file';
    if (o.accept) input.accept = o.accept;
    input.hidden = true;
    const btn = UI.el('button', 'btn small', UI.icon('upload') + '<span>' + UI.esc(o.label || 'Choose file') + '</span>');
    btn.type = 'button';
    const name = UI.el('span', 'name', 'No file selected');
    host.append(input, btn, name);
    btn.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      const f = input.files && input.files[0];
      if (!f) return;
      name.textContent = f.name;
      if (o.onFile) o.onFile(f);
    });
    return { setName: (t) => { name.textContent = t; } };
  };

  /* --------------------------------------------------------------- toast */
  UI.toast = function (msg, kind, ms) {
    const box = document.getElementById('toasts');
    const t = UI.el('div', 'toast ' + (kind || 'info'), UI.icon(kind === 'ok' ? 'check' : kind === 'err' ? 'alert' : 'info') + '<span>' + UI.esc(msg) + '</span>');
    box.appendChild(t);
    setTimeout(() => { t.style.transition = 'opacity .25s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 260); }, ms || 4500);
  };

  /* --------------------------------------------------------------- modal */
  UI.modal = function (o) {
    const overlay = UI.el('div', 'overlay');
    const dlg = UI.el('div', 'dialog');
    dlg.setAttribute('role', 'dialog'); dlg.setAttribute('aria-modal', 'true');
    if (o.title) { const h = UI.el('h2', null, UI.esc(o.title)); h.id = 'dlg-title'; dlg.setAttribute('aria-labelledby', 'dlg-title'); dlg.appendChild(h); }
    if (o.lead) dlg.appendChild(UI.el('p', 'lead', UI.esc(o.lead)));
    const body = UI.el('div', 'stack');
    if (o.body) { if (typeof o.body === 'string') body.innerHTML = o.body; else body.appendChild(o.body); }
    dlg.appendChild(body);
    const actions = UI.el('div', 'dialog-actions');
    (o.actions || [{ label: 'Close', kind: 'primary' }]).forEach((a) => {
      const b = UI.el('button', 'btn ' + (a.kind || ''), (a.icon ? UI.icon(a.icon) : '') + '<span>' + UI.esc(a.label) + '</span>');
      b.type = 'button';
      b.addEventListener('click', () => { if (!a.onClick || a.onClick(api) !== false) { if (!a.keepOpen) api.close(); } });
      actions.appendChild(b);
      a._el = b;
    });
    dlg.appendChild(actions);
    overlay.appendChild(dlg);
    const prevFocus = document.activeElement;
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); api.close(); }
      else if (e.key === 'Tab') {
        const f = dlg.querySelectorAll('button:not([disabled]),input:not([hidden]),[tabindex="0"]');
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    const api = {
      el: dlg, body: body, actions: o.actions,
      close() { if (!overlay.isConnected) return; overlay.remove(); document.removeEventListener('keydown', onKey, true); if (prevFocus && prevFocus.focus) prevFocus.focus(); if (o.onClose) o.onClose(); },
    };
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay && !o.sticky) api.close(); });
    document.addEventListener('keydown', onKey, true);
    document.getElementById('app').appendChild(overlay);
    const first = dlg.querySelector('input:not([hidden]),button');
    if (first) first.focus();
    return api;
  };

  /* ------------------------------------------------------------- tooltip */
  UI.initTooltips = function () {
    const tip = document.getElementById('tooltip');
    let timer = null, target = null;
    const hide = () => { clearTimeout(timer); tip.hidden = true; target = null; };
    const show = (el) => {
      tip.textContent = el.getAttribute('data-tip');
      tip.hidden = false;
      const r = el.getBoundingClientRect(), side = el.getAttribute('data-tip-side') || 'bottom';
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      let x, y;
      if (side === 'left') { x = r.left - tw - 10; y = r.top + (r.height - th) / 2; }
      else if (side === 'right') { x = r.right + 10; y = r.top + (r.height - th) / 2; }
      else { x = r.left + (r.width - tw) / 2; y = r.bottom + 8; }
      tip.style.left = clamp(x, 6, window.innerWidth - tw - 6) + 'px';
      tip.style.top = clamp(y, 6, window.innerHeight - th - 6) + 'px';
    };
    document.addEventListener('pointerover', (e) => {
      if (e.pointerType === 'touch') return;
      const el = e.target.closest && e.target.closest('[data-tip]');
      if (!el || el === target) return;
      hide(); target = el; timer = setTimeout(() => show(el), 350);
    });
    document.addEventListener('pointerout', (e) => { if (target && !target.contains(e.relatedTarget)) hide(); });
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('scroll', hide, true);
  };

  window.UI = UI;
})();
