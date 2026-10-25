/* ArcGIS GeoJSON -> map-generator geometry, clipped in the browser worker. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RWArcGIS = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function landTags(properties) {
    const entry = Object.entries(properties || {}).find(([k]) => k.toLowerCase() === 'land_cover');
    const name = String(entry ? entry[1] : '').toLowerCase();
    if (name === 'lakes') return { natural: 'water' };
    if (name.includes('forest') || name === 'mangroves') return { natural: 'wood' };
    if (name === 'deserts') return { natural: 'desert' };
    if (name === 'bare earth' || name === 'rock and ice') return { natural: 'bare_rock' };
    if (name === 'swamp') return { natural: 'wetland' };
    if (name.includes('grassland')) return { natural: 'grassland' };
    return null;
  }

  function clipRingToBounds(ring, bbox) {
    if (!Array.isArray(ring) || ring.length < 4) return [];
    let pts = ring.slice(0, ring.length - 1).map((p) => [Number(p[0]), Number(p[1])])
      .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (pts.length < 3) return [];

    const clipEdge = (input, inside, intersect) => {
      const output = [];
      if (!input.length) return output;
      let prev = input[input.length - 1], prevIn = inside(prev);
      for (const cur of input) {
        const curIn = inside(cur);
        if (curIn !== prevIn) output.push(intersect(prev, cur));
        if (curIn) output.push(cur);
        prev = cur;
        prevIn = curIn;
      }
      return output;
    };
    const vertical = (x, a, b) => {
      const t = (x - a[0]) / (b[0] - a[0]);
      return [x, a[1] + (b[1] - a[1]) * t];
    };
    const horizontal = (y, a, b) => {
      const t = (y - a[1]) / (b[1] - a[1]);
      return [a[0] + (b[0] - a[0]) * t, y];
    };
    pts = clipEdge(pts, (p) => p[0] >= bbox.w, (a, b) => vertical(bbox.w, a, b));
    pts = clipEdge(pts, (p) => p[0] <= bbox.e, (a, b) => vertical(bbox.e, a, b));
    pts = clipEdge(pts, (p) => p[1] >= bbox.s, (a, b) => horizontal(bbox.s, a, b));
    pts = clipEdge(pts, (p) => p[1] <= bbox.n, (a, b) => horizontal(bbox.n, a, b));
    if (pts.length < 3) return [];
    pts.push(pts[0]);
    return pts;
  }

  function clipLineToBounds(coords, bbox) {
    const output = [];
    let current = [];
    const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-8 && Math.abs(a[1] - b[1]) < 1e-8;
    const clipSegment = (a, b) => {
      const dx = b[0] - a[0], dy = b[1] - a[1];
      let t0 = 0, t1 = 1;
      const p = [-dx, dx, -dy, dy];
      const q = [a[0] - bbox.w, bbox.e - a[0], a[1] - bbox.s, bbox.n - a[1]];
      for (let i = 0; i < 4; i++) {
        if (p[i] === 0) { if (q[i] < 0) return null; continue; }
        const r = q[i] / p[i];
        if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
        else { if (r < t0) return null; if (r < t1) t1 = r; }
      }
      return [[a[0] + t0 * dx, a[1] + t0 * dy], [a[0] + t1 * dx, a[1] + t1 * dy]];
    };
    const flush = () => { if (current.length > 1) output.push(current); current = []; };
    for (let i = 0; i + 1 < (coords || []).length; i++) {
      const a = coords[i], b = coords[i + 1];
      if (!Array.isArray(a) || !Array.isArray(b) || a.length < 2 || b.length < 2) { flush(); continue; }
      const seg = clipSegment([Number(a[0]), Number(a[1])], [Number(b[0]), Number(b[1])]);
      if (!seg) { flush(); continue; }
      if (current.length && same(current[current.length - 1], seg[0])) current.push(seg[1]);
      else { flush(); current = [seg[0], seg[1]]; }
    }
    flush();
    return output;
  }

  function roadTags(properties) {
    const type = String((properties || {}).type || (properties || {}).TYPE || (properties || {}).featurecla || '').toLowerCase();
    if (type.includes('ferry')) return null;
    if (type.includes('motorway') || type.includes('freeway') || type.includes('interstate')) return { highway: 'motorway' };
    if (type.includes('major') || type.includes('trunk') || type.includes('primary') || type.includes('highway')) return { highway: 'primary' };
    if (type.includes('secondary')) return { highway: 'secondary' };
    if (type.includes('road') || type.includes('street') || type.includes('route')) return { highway: 'tertiary' };
    return { highway: 'primary' };
  }

  function featureToElements(feature, kind, bbox, firstId) {
    const rawGeometry = feature && feature.geometry;
    if (!rawGeometry || !bbox) return [];
    let g = rawGeometry;
    // ArcGIS FeatureServer queries reliably support f=json; translate Esri JSON
    // geometries to the small GeoJSON-like shape used by the rasterizer.
    if (!g.type && Array.isArray(g.rings)) {
      g = { type: 'Polygon', coordinates: g.rings };
    } else if (!g.type && Array.isArray(g.paths)) {
      g = g.paths.length > 1
        ? { type: 'MultiLineString', coordinates: g.paths }
        : { type: 'LineString', coordinates: g.paths[0] || [] };
    } else if (!g.type && Number.isFinite(g.x) && Number.isFinite(g.y)) {
      return [];
    }
    if (!g.type || !g.coordinates) return [];
    const properties = feature.properties || feature.attributes || {};
    let tags;
    if (kind === 'water') tags = { natural: 'water' };
    else if (kind === 'rivers') tags = { waterway: 'river' };
    else if (kind === 'land') tags = landTags(properties);
    else if (kind === 'roads') tags = roadTags(properties);
    else return [];
    if (!tags) return [];

    const point = (p) => {
      if (!Array.isArray(p) || p.length < 2) return null;
      const lon = Number(p[0]), lat = Number(p[1]);
      return Number.isFinite(lat) && Number.isFinite(lon) ? { lat: lat, lon: lon } : null;
    };
    const toGeometry = (coords) => (Array.isArray(coords) ? coords.map(point).filter(Boolean) : []);
    const out = [];
    let id = Number.isFinite(firstId) ? firstId : 1;
    const addPolygon = (rings) => {
      const clipped = (rings || []).map((ring) => clipRingToBounds(ring, bbox));
      if (!clipped.length || clipped[0].length < 4) return;
      const members = clipped.map((ring, i) => ({
        type: 'way', role: i === 0 ? 'outer' : 'inner', ref: id++, geometry: toGeometry(ring),
      })).filter((m) => m.geometry.length >= 4);
      if (members.length) out.push({ type: 'relation', id: id++, tags: tags, members: members });
    };
    const addLine = (coords) => {
      for (const clippedLine of clipLineToBounds(coords, bbox)) {
        const geometry = toGeometry(clippedLine);
        if (geometry.length > 1) out.push({ type: 'way', id: id++, tags: tags, geometry: geometry });
      }
    };

    if (g.type === 'Polygon') addPolygon(g.coordinates);
    else if (g.type === 'MultiPolygon') g.coordinates.forEach(addPolygon);
    else if (g.type === 'LineString') addLine(g.coordinates);
    else if (g.type === 'MultiLineString') g.coordinates.forEach(addLine);
    return out;
  }

  return { landTags: landTags, roadTags: roadTags, clipRingToBounds: clipRingToBounds, clipLineToBounds: clipLineToBounds, featureToElements: featureToElements };
});
