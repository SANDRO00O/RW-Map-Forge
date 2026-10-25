// Builds public/catalog.json (tileset index) and copies the tile bitmaps into public/tilesets/.
// Usage: node scripts/build-catalog.mjs
import { readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { join, basename, extname, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'tilesets-src');
const OUT = join(ROOT, 'public');
const BITMAPS = join(SRC, 'bitmaps');

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
function pngSize(file) {
  const b = readFileSync(file).subarray(0, 24);
  if (b.readUInt32BE(0) !== 0x89504e47) return [0, 0];
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}
const attr = (s, name, d = null) => {
  const m = new RegExp('\\b' + name + '="([^"]*)"').exec(s);
  return m ? m[1] : d;
};

function entry(id, name, attrs, inner, tsx, pngFile) {
  const [iw, ih] = pngSize(pngFile);
  const imTag = (/<image\b[^>]*>/.exec(inner) || [''])[0];
  const w = +attr(imTag, 'width', iw) || iw, h = +attr(imTag, 'height', ih) || ih;
  const tw = +attr(attrs, 'tilewidth', 20), th = +attr(attrs, 'tileheight', 20);
  const sp = +attr(attrs, 'spacing', 0), mg = +attr(attrs, 'margin', 0);
  // counts come from the real PNG size (the tsx may declare less than the image holds)
  const cols = Math.max(1, Math.floor(((iw || w) - 2 * mg + sp) / (tw + sp)));
  const rows = Math.max(1, Math.floor(((ih || h) - 2 * mg + sp) / (th + sp)));
  const declared = +attr(attrs, 'tilecount', 0) || 0;
  return {
    id, name, attrs, inner, tsx,
    png: '/tilesets/bitmaps/' + basename(pngFile),
    w, h, tw, th, spacing: sp, margin: mg, cols, rows,
    count: Math.max(cols * rows, declared),
    trans: attr(imTag, 'trans', '008a76'),
  };
}

const cat = {};
for (const f of walk(SRC).filter((p) => extname(p) === '.tsx').sort()) {
  const txt = readFileSync(f, 'utf8').replace(/^\uFEFF/, '').replace(/\r/g, '');
  const m = /<tileset\b([^>]*)>([\s\S]*)<\/tileset>/.exec(txt);
  if (!m) continue;
  const attrs = m[1].trim(), inner = m[2];
  const im = /<image\b[^>]*source="([^"]+)"/.exec(inner);
  if (!im) continue;
  const id = basename(im[1], extname(im[1])).toLowerCase();
  if (cat[id]) continue;
  const name = attr(attrs, 'name', basename(f, '.tsx'));
  cat[id] = entry(id, name, attrs, inner, relative(SRC, f).split('\\').join('/'), join(BITMAPS, basename(im[1])));
}
// bitmaps that have no .tsx get a synthesized definition (preview only; never used for export)
for (const f of readdirSync(BITMAPS).filter((n) => n.endsWith('.png')).sort()) {
  const id = basename(f, '.png').toLowerCase();
  if (cat[id]) continue;
  const [iw, ih] = pngSize(join(BITMAPS, f));
  const attrs = `name="${basename(f, '.png')}" tilewidth="20" tileheight="20"`;
  const inner = `\n <image source="bitmaps/${f}" trans="008a76" width="${iw}" height="${ih}"/>\n`;
  cat[id] = entry(id, basename(f, '.png'), attrs, inner, null, join(BITMAPS, f));
}

mkdirSync(join(OUT, 'tilesets', 'bitmaps'), { recursive: true });
for (const f of readdirSync(BITMAPS).filter((n) => n.endsWith('.png'))) {
  copyFileSync(join(BITMAPS, f), join(OUT, 'tilesets', 'bitmaps', f));
}
writeFileSync(join(OUT, 'catalog.json'), JSON.stringify(cat));
console.log(`catalog: ${Object.keys(cat).length} tilesets, ${(JSON.stringify(cat).length / 1024).toFixed(0)} KB`);
