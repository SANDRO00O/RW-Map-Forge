# RW Map Forge

Generate playable **Rusted Warfare** maps from real-world terrain. Pick any place on Earth, tune the terrain,
preview the result, place players and resources, and export a `.tmx` map.

The browser app and Cloudflare Pages Function are plain JavaScript. The global-data importer uses Python + GDAL in GitHub Actions; normal map generation does not run that importer.

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
| `GET /api/terrain-status` | Reports whether the full global terrain import has completed in R2. |
| `GET /api/hydro-tile?source=water\|rivers\|roads\|landmask&x=&y=` | Serves locally stored compressed water, river, road and global land/ocean coastline vector tiles. |
| `GET /api/landcover-tile?x=&y=` | Serves locally stored compressed global land-cover class tiles. |
| `POST /api/terrain-features` | Legacy on-demand cache retained as a fallback before the full global import is ready. |
| `GET /api/geocode?q` | Place search through Nominatim with a proper User-Agent and edge caching. |

The Worker does no heavy computation (the free plan allows about 10 ms of CPU per request). All terrain processing runs in a
Web Worker inside the visitor's browser, which also keeps the page responsive.


## Global terrain data hosted in R2

The project has a Cloudflare R2 bucket named `rw-map-forge-terrain` and Pages Function binding `TERRAIN_CACHE` in production and preview. The importer writes a completion manifest only after all required datasets—including the global land/ocean mask—are processed successfully. Until `GET /api/terrain-status` returns `{"ready":true}`, map generation keeps the older online-data path as a migration fallback.

### Global import and dataset updates

1. In Cloudflare R2, create an API token with **Object Read & Write** permission scoped only to the `rw-map-forge-terrain` bucket.
2. In GitHub, open Settings → Secrets and variables → Actions and add these repository **secrets**: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY`. Do not put the credentials in source code or regular Actions variables.
3. Open [Import global terrain datasets to R2](https://github.com/SANDRO00O/RW-Map-Forge/actions/workflows/import-global-terrain.yml), choose **Run workflow**, set `confirm_global_import` to `yes`, and start it. The workflow downloads, simplifies and tiles the datasets, then uploads the compressed results. Its import is limited to 9 GB per run to avoid silently exceeding the R2 free storage allocation.
4. Verify [the terrain status endpoint](https://rw-map-forge.pages.dev/api/terrain-status). It should return `"ready":true` and non-zero tile counts. Only then is the site using its preloaded global tiles instead of its online-data fallback.

The import uses:
- **Natural Earth 1:10m land polygons** as the global land/ocean mask (public domain; broad coastline context, not a survey-grade shoreline).
- **HydroLAKES v1** polygons for lakes and reservoirs (CC BY 4.0; attribution required).
- **HydroRIVERS v1**, simplified and filtered to Strahler order 3 or higher, to keep the stored river network useful at game-map scale. HydroSHEDS notes reduced source quality north of 60° N, so the source is not perfect everywhere.
- **Natural Earth 1:10m roads** for a compact, globally hosted major-road overlay (public domain; not a street-level road database).
- **MODIS MCD12Q1 v061, 2021 IGBP land-cover class**, downsampled to 0.025° cells (approximately 2.8 km at the equator) and translated into the map generator's six land categories plus water. The source raster covers approximately 62° S to 87.37° N; outside that extent the generator continues using its elevation-based terrain rules.

The importer is an explicit GitHub Actions operation because dataset preparation and R2 uploads require an R2 S3 access key. The application does not need those credentials; it accesses only the R2 binding from its Pages Function. Repeated map generation reads locally hosted tiles, so the global coastline, water, rivers, roads and land cover do not require public map APIs after import.

**Important for existing installations:** if the R2 import was completed before the ocean-mask fix, run this workflow once more with `confirm_global_import=yes`. The importer reuses existing objects and adds the missing `landmask` tiles; do not use the global coastline mask until the refreshed manifest reports it as ready.

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
* After the refreshed R2 import: Natural Earth land polygons for the ocean mask, HydroRIVERS, HydroLAKES, Natural Earth major roads and MODIS MCD12Q1 2021 land cover (see the import section for licenses, attribution and coverage limitations).
* Migration fallback before the import is complete: ArcGIS FeatureServer for water and land cover and Overpass for the major-road overlay. Place search continues to use Nominatim.
* Base maps: CARTO and Esri World Imagery. Please respect their usage policies; for a high-traffic public deployment use a base-map provider you have an account with (edit `LAYERS` in `public/js/app.js` and the `img-src` CSP in `public/_headers`).

Rusted Warfare is a trademark of Corroding Games. This is an unofficial fan tool.
