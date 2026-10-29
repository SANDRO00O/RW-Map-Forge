<!-- Project banner -->
<p align="center">
  <a href="https://rw-map-forge.pages.dev">
    <img src="docs/assets/rw-map-forge-banner.svg" alt="RW Map Forge original terrain logo" width="320">
  </a>
</p>

<p align="center">
  <a href="https://rw-map-forge.pages.dev"><img src="https://img.shields.io/badge/Live%20Demo-Open%20App-1687e8?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Open the live application"></a>
  <a href="https://github.com/SANDRO00O/RW-Map-Forge/actions/workflows/tests.yml"><img src="https://img.shields.io/github/actions/workflow/status/SANDRO00O/RW-Map-Forge/tests.yml?branch=master&style=for-the-badge&label=Tests" alt="Automated test workflow status"></a>
  <a href="https://github.com/SANDRO00O/RW-Map-Forge"><img src="https://img.shields.io/badge/Source-GitHub-20232a?style=for-the-badge&logo=github&logoColor=white" alt="Source code on GitHub"></a>
  <img src="https://img.shields.io/badge/Runtime-Cloudflare%20Workers-f38020?style=for-the-badge&logo=cloudflare&logoColor=white" alt="Cloudflare Workers runtime">
</p>

<h3 align="center">Real-world terrain. Ready-to-play maps.</h3>

<p align="center">
  RW Map Forge is a browser-based map generator for <strong>Rusted Warfare</strong>. Choose a location, customise the terrain, preview your map, and export it as a <code>.tmx</code> file for use in the game.
</p>

<p align="center">
  <a href="https://rw-map-forge.pages.dev"><strong>Open the map generator</strong></a>
  &nbsp;·&nbsp;
  <a href="#quick-start">Quick start</a>
  &nbsp;·&nbsp;
  <a href="#developer-guide">Developer guide</a>
</p>

---

## Overview

RW Map Forge turns real-world geographic data into playable Rusted Warfare maps. Instead of building every landscape by hand, you can start with a place on Earth and use its terrain, water features, and land-cover data to create a map.

The application is designed to be straightforward to use. Map processing runs primarily in a browser Web Worker, keeping the interface responsive while terrain is classified and the map is assembled. A Cloudflare Worker provides cached data and API endpoints for terrain tiles and place search.

## Features

- **Real-world terrain** — uses elevation data to help shape terrain and elevation-driven features.
- **Land cover and biomes** — classifies available global land-cover data into the terrain categories used by the generator.
- **Water and coastlines** — combines lake, river, and coastline data with shallow-water shoreline transitions.
- **Major roads and geographic features** — adds selected real-world features at a scale suitable for game maps.
- **Map customisation** — adjust map settings and configure player and resource placement.
- **Responsive generation** — performs heavy map-processing work in a browser Web Worker instead of blocking the main interface.
- **Rusted Warfare export** — produces a `.tmx` map with game-compatible layers and tileset references.
- **Flexible tilesets** — export with external `.tsx` references, embed tilesets, or copy tileset settings from a working map.

## Quick start

You can use the hosted application without installing anything.

1. **Open the application:** [rw-map-forge.pages.dev](https://rw-map-forge.pages.dev).
2. **Choose a location:** search for a place and set up the map area.
3. **Configure and generate:** choose the available map settings, then generate and review the result.
4. **Export the map:** download the `.tmx` file and import it into Rusted Warfare using the game's map workflow.

If the game does not accept an exported map, try the export option **Copy from a working map** and provide a `.tmx` file that already works in your installation.

## How terrain data works

The map generator combines several types of geographic information:

| Data | Purpose |
| --- | --- |
| Elevation | Helps determine height-driven terrain and land features. |
| Land/ocean mask | Separates land from ocean areas along broad global coastlines. |
| Lakes and rivers | Adds inland-water features to the generated map. |
| Land cover | Helps classify terrain where the source dataset provides coverage. |
| Major roads | Supplies a simplified road overlay for supported locations. |
| Place search | Lets you find a location by name. |

### Data coverage and limitations

The source datasets are designed for geographic context, not survey-grade or street-level accuracy. Natural Earth coastline data is deliberately generalised, the road dataset contains major roads rather than every local street, and land-cover classes are based on a coarse raster rather than live conditions. The MODIS land-cover input used by the importer covers approximately 62° S to 87.37° N at a downsampled resolution of 0.025° (about 2.8 km at the equator). Outside its coverage, the generator falls back to its elevation-based terrain rules.

Global preloaded terrain data is used when the terrain status endpoint reports that the import is ready. You can check the current status at [`/api/terrain-status`](https://rw-map-forge.pages.dev/api/terrain-status).

## Developer guide

### Requirements

- Node.js 22 or a compatible recent Node.js release.
- npm.
- A Cloudflare account and Wrangler for Cloudflare-based development or deployment.

### Run locally

Clone the repository and install dependencies:

```bash
git clone https://github.com/SANDRO00O/RW-Map-Forge.git
cd RW-Map-Forge
npm install
```

Choose a development mode:

```bash
npm run dev                 # Run with Wrangler and the Worker runtime
npm run dev:local           # Run the lightweight local Node.js server
MOCK=1 npm run dev:local    # Use synthetic data for offline development
```

The Wrangler mode uses the Worker runtime. The lightweight local server is useful for UI development and can run against live upstream sources; set `MOCK=1` to use synthetic data instead.

### Build and test

```bash
npm run build   # Regenerate the tileset catalog from tilesets-src/
npm test        # Run the automated test suites
```

The GitHub Actions test workflow also validates the global terrain import script and the browser worker's JavaScript syntax. For browser end-to-end coverage, the repository includes `tests/e2e.py`, which requires the test server and Playwright for Python to be available.

### Project structure

| Path | Responsibility |
| --- | --- |
| `public/` | Static application, styles, browser scripts, tilesets, and generated catalog. |
| `public/js/pipeline.worker.js` | Downloads and processes map data, classifies terrain, and builds the TMX output without blocking the UI. |
| `src/worker.js` | Cloudflare Worker endpoints for terrain data and place search. |
| `scripts/build-catalog.mjs` | Generates `public/catalog.json` from the source tilesets. |
| `scripts/import-global-terrain.py` | Prepares and uploads the global terrain datasets. |
| `tilesets-src/` | Source Rusted Warfare tileset definitions and bitmap assets. |
| `tests/` | Unit tests, a local development server, and browser end-to-end tests. |

## API overview

The Cloudflare Worker exposes the following application endpoints:

| Endpoint | Description |
| --- | --- |
| `GET /api/dem?z&x0&x1&y0&y1` | Fetches a batch of elevation tiles in one request. |
| `GET /api/terrain-status` | Reports whether the global terrain import is ready and provides dataset status. |
| `GET /api/hydro-tile?source=water\|rivers\|roads\|landmask&x=&y=` | Serves locally stored compressed water, river, road, or land/ocean-mask tiles. |
| `GET /api/landcover-tile?x=&y=` | Serves locally stored compressed land-cover tiles. |
| `POST /api/terrain-features` | Legacy on-demand terrain-data fallback used during migration or when the global import is not ready. |
| `GET /api/geocode?q=` | Searches for place names through Nominatim with edge caching. |

Terrain processing stays in the visitor's browser. The Worker primarily retrieves, combines, and caches data, which helps keep CPU-intensive work away from the request handler.

## Global terrain data maintenance

The repository includes a manual GitHub Actions workflow for importing or refreshing the global datasets in Cloudflare R2. This operation is for maintainers; normal map generation does not require R2 access keys in the browser.

1. Create or verify the `rw-map-forge-terrain` bucket in Cloudflare R2 and configure the `TERRAIN_CACHE` binding for the Worker.
2. In the repository's **Settings → Secrets and variables → Actions**, configure `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY`. Use an R2 token scoped to object read/write access for this bucket only.
3. Open [Import global terrain datasets to R2](https://github.com/SANDRO00O/RW-Map-Forge/actions/workflows/import-global-terrain.yml), select **Run workflow**, and set `confirm_global_import` to `yes`.
4. Check [the terrain status endpoint](https://rw-map-forge.pages.dev/api/terrain-status). The import is ready when the response reports `"ready": true` and includes non-zero tile counts.

The importer caps each run at 9 GB to help control storage use. Keep R2 credentials in GitHub Actions secrets; never commit them to the repository or expose them to the browser.

## Data sources and attribution

The project uses data from several external providers. Their terms and coverage limitations still apply.

- **Elevation:** Terrarium-encoded terrain tiles from [AWS Open Data](https://registry.opendata.aws/terrain-tiles/).
- **Global land/ocean mask and major roads:** [Natural Earth](https://www.naturalearthdata.com/), public-domain map datasets at 1:10m scale.
- **Lakes:** [HydroLAKES v1](https://www.hydrosheds.org/products/hydrolakes), distributed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) and requiring attribution.
- **Rivers:** [HydroRIVERS v1](https://www.hydrosheds.org/products/hydrorivers). The imported network is simplified and filtered to Strahler order 3 or higher; source quality is reduced in some areas north of 60° N.
- **Land cover:** [MODIS MCD12Q1 v061](https://lpdaac.usgs.gov/products/mcd12q1v061/), using the 2021 IGBP land-cover classification.
- **Place search:** [Nominatim](https://nominatim.org/) based on OpenStreetMap data; follow the [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/).
- **Base maps:** CARTO and Esri World Imagery. Please follow each provider's attribution and usage policies. For a high-traffic deployment, configure a provider and access plan appropriate to your use case.

Before redistributing source data or running a public deployment at scale, review the relevant provider documentation and terms.

## License and trademarks

This repository does not currently include a software license file. Until a license is added, do not assume that the source code may be reused or redistributed under an open-source license.

Rusted Warfare is a trademark of Corroding Games. RW Map Forge is an unofficial fan-made tool and is not affiliated with or endorsed by Corroding Games.
