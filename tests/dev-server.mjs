// Zero-dependency local server: serves public/ and runs src/worker.js for /api/*.
//   node tests/dev-server.mjs            real upstream services (needs internet)
//   MOCK=1 node tests/dev-server.mjs     synthetic upstream data (offline tests)
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/worker.js';
import { installMockFetch } from './mock-upstream.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = +(process.env.PORT || 8787);
if (process.env.MOCK) installMockFetch();

// Minimal stand-in for the Workers Cache API
const store = new Map();
globalThis.caches = {
  default: {
    async match(req) { const r = store.get(req.url); return r ? r.clone() : undefined; },
    async put(req, res) { store.set(req.url, new Response(await res.arrayBuffer(), { status: res.status, headers: res.headers })); },
  },
};

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const r = await worker.fetch(new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }), {}, { waitUntil: (p) => p.catch(() => {}) });
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    let p = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    if (p === '/' || p === '\\') p = '/index.html';
    const file = join(ROOT, p);
    if (!file.startsWith(ROOT) || !(await stat(file).catch(() => null))?.isFile()) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(await readFile(file));
  } catch (e) { res.writeHead(500); res.end(String(e && e.message || e)); }
}).listen(PORT, () => console.log(`RW Map Forge dev server: http://localhost:${PORT}${process.env.MOCK ? '  (mock upstream data)' : ''}`));
