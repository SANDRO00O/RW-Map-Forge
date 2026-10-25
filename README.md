# RW Map Forge

Generate playable **Rusted Warfare** maps from real-world terrain. Pick any place on Earth, tune the terrain,
preview the result, place players and resources, and export a `.tmx` map.

The whole project is plain JavaScript: a static site plus one Cloudflare Worker. No Python, no build step, no framework.

```
public/            static site (served by Workers Static Assets)
  index.html, css/, js/
  js/pipeline.worker.js   Web Worker: downloads data, classifies terrain, builds the TMX (keeps the UI responsive)
  catalog.json, tilesets/ generated tileset index + tile bitmaps
src/worker.js      Cloudflare Worker: /api/dem, /api/osm, /api/geocode
scripts/           build-catalog.mjs (regenerates catalog.json from tilesets-src/)
tilesets-src/      original Rusted Warfare .tsx files and bitmaps
tests/             unit test, local dev server with mock data, browser end-to-end test
```

## How the Worker speeds things up

| Endpoint | What it does |
| --- | --- |
| `GET /api/dem?z&x0&x1&y0&y1` | Fetches up to 40 elevation tiles **in parallel at the edge** and returns them in one response, cached by Cloudflare. A map needs one request instead of dozens. |
| `POST /api/terrain-features` | Queries public ArcGIS REST services for water bodies, linear rivers, and global land-cover classes, clips geometry to the selected bounds, and caches results at the edge. |
| `POST /api/osm` | Optional Overpass proxy for the roads overlay only. Water and land-cover generation no longer depends on public Overpass instances. |
| `GET /api/geocode?q` | Place search through Nominatim with a proper User-Agent and edge caching. |

The Worker does no heavy computation (the free plan allows about 10 ms of CPU per request). All terrain processing runs in a
Web Worker inside the visitor's browser, which also keeps the page responsive.

## Deploy to Cloudflare (free plan)

1. Install dependencies and sign in:
   ```bash
   npm install
   npx wrangler login
   ```
2. Deploy:
   ```bash
   npm run deploy
   ```
   Wrangler uploads `public/` as static assets and publishes `src/worker.js`. You get a `*.workers.dev` URL; add a custom
   domain in the Cloudflare dashboard if you like (Workers & Pages, your Worker, Settings, Domains & Routes).

Configuration lives in `wrangler.toml`. Static files are served first; anything that is not a file (for example `/api/*`) goes to the Worker.
Security and caching headers are defined in `public/_headers`.

## Run locally

```bash
npm run dev          # wrangler dev: the real Worker runtime
npm run dev:local    # zero-dependency Node server (no wrangler needed), real upstream services
MOCK=1 npm run dev:local   # same, with synthetic data so it works offline
```

## Tests

```bash
npm test                                  # generator unit tests (classification, autotiling, TMX, OSM raster)
MOCK=1 node tests/dev-server.mjs &        # then, with Playwright for Python installed:
python3 tests/e2e.py                      # drives the real UI on desktop and mobile viewports and validates the exported TMX
```

## What the exported map contains

* `Ground`, `Items` and `Units` layers (20x20 tiles), Base64 + gzip by default (zlib and CSV are available).
* Water is the `Shallow Water` tile (id 0). Land uses id 0 of each terrain tileset. Edges use only the original `_flat` transition sets (3x7 layout).
* Resource pools are 3x3 blocks of `misc` tiles; every player gets a command center and a builder.
* Tilesets are written as external `.tsx` references by default (editable folder prefix), or embedded, or copied from any working map you upload.
* An optional `Triggers` / `map_info` layer.

If the game rejects a map, use the export option **Copy from a working map** and upload any `.tmx` that already works for you.

## Data sources and attribution

* Elevation: Terrain Tiles on AWS Open Data (Terrarium encoding).
* Water bodies: Esri/Garmin World Water Bodies; linear water features: Esri Detailed Linear Hydrology.
* Broad land-cover classes: University of Minnesota Global Land Cover (ArcGIS Feature Service).
* Optional road overlay and place search: OpenStreetMap contributors (ODbL) through Overpass and Nominatim. Base maps: CARTO and Esri World Imagery. Please respect their usage policies; for a high-traffic public
  deployment use a base-map provider you have an account with (edit `LAYERS` in `public/js/app.js` and the `img-src` CSP in `public/_headers`).

Rusted Warfare is a trademark of Corroding Games. This is an unofficial fan tool.
