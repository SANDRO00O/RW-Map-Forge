// Synthetic upstream responses so the whole stack can be exercised without internet access.
import zlib from 'node:zlib';

const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(rgb) {               // 256x256 RGB, filter type 0
  const raw = Buffer.alloc(256 * (256 * 3 + 1));
  for (let y = 0; y < 256; y++) { raw[y * 769] = 0; rgb.copy(raw, y * 769 + 1, y * 768, (y + 1) * 768); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(256, 0); ihdr.writeUInt32BE(256, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function demTile(z, tx, ty) {
  const P = 256 * 2 ** z, rgb = Buffer.alloc(256 * 256 * 3);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const gx = tx * 256 + x + 0.5, gy = ty * 256 + y + 0.5;
    const lon = gx / P * 360 - 180, lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * gy / P))) * 180 / Math.PI;
    let e = 600 + 700 * Math.sin(lon * 55) * Math.cos(lat * 70) + 500 * Math.exp(-(((lon - 8.0) * 90) ** 2 + ((lat - 46.56) * 90) ** 2));
    if (lon < 7.965) e = -40;
    const v = e + 32768, i = (y * 256 + x) * 3;
    rgb[i] = Math.floor(v / 256); rgb[i + 1] = Math.floor(v) % 256; rgb[i + 2] = Math.floor((v - Math.floor(v)) * 256);
  }
  return png(rgb);
}
const ring = (lat, lon, dx, dy) => [[-dx, -dy], [dx, -dy], [dx, dy], [-dx, dy], [-dx, -dy]].map(([a, b]) => ({ lat: lat + b, lon: lon + a }));

export function installMockFetch() {
  const real = globalThis.fetch;
  globalThis.__osmCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    let m;
    if ((m = /elevation-tiles-prod.*\/terrarium\/(\d+)\/(\d+)\/(\d+)\.png/.exec(url))) {
      return new Response(demTile(+m[1], +m[2], +m[3]), { headers: { 'content-type': 'image/png' } });
    }
    if (url.includes('/api/interpreter')) {
      globalThis.__osmCalls++;
      const body = String(init && init.body || '');
      const els = [];
      if (body.includes('natural%22%3D%22water') || body.includes('natural"="water')) els.push({ type: 'way', tags: { natural: 'water' }, geometry: ring(46.545, 8.0, 0.01, 0.006) });
      else els.push({ type: 'way', tags: { natural: 'wood' }, geometry: ring(46.57, 8.02, 0.01, 0.006) });
      return new Response(JSON.stringify({ elements: els }), { headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('nominatim.openstreetmap.org')) {
      return new Response(JSON.stringify([{ display_name: 'Interlaken, Bern, Switzerland', lat: '46.6863', lon: '7.8632', type: 'town' }, { display_name: 'Interlaken Airport, Bern', lat: '46.67', lon: '7.88', type: 'aerodrome' }]), { headers: { 'content-type': 'application/json' } });
    }
    return real(input, init);
  };
}
