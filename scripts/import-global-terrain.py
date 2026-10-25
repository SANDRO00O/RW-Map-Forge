#!/usr/bin/env python3
"""Build compact, self-hosted global terrain tiles and upload them to Cloudflare R2.

The importer reuses successfully uploaded tiles when rerun after a failure. It
only publishes manifest.ready=true after every dataset has been processed.
"""
from __future__ import annotations

import concurrent.futures
import gzip
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import time
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import boto3
import numpy as np
import rasterio
from rasterio.windows import Window

BUCKET = "rw-map-forge-terrain"
PREFIX = "global/v1"
HYDRO_DEG = 4
ROAD_DEG = 10
LAND_DEG = 10
LAND_RES = 0.025
LAND_SIDE = int(LAND_DEG / LAND_RES)  # 400 pixels per side
MAX_UPLOAD_BYTES = int(float(os.environ.get('MAX_UPLOAD_GB', '9')) * (1024 ** 3))
_uploaded_bytes = 0
_upload_lock = __import__('threading').Lock()

HYDRORIVERS_URL = "https://data.hydrosheds.org/file/HydroRIVERS/HydroRIVERS_v10_shp.zip"
HYDROLAKES_URL = "https://data.hydrosheds.org/file/hydrolakes/HydroLAKES_polys_v10_shp.zip"
NATURAL_EARTH_ROADS_URL = "https://naciscdn.org/naturalearth/10m/cultural/ne_10m_roads.zip"
MODIS_LANDCOVER_URL = (
    "https://zenodo.org/records/8367523/files/"
    "lc_mcd12q1v061.t1_c_500m_s_20210101_20211231_go_epsg.4326_v20230818.tif?download=1"
)

def log(message: str) -> None:
    print(f"[{datetime.now(timezone.utc).isoformat(timespec='seconds')}] {message}", flush=True)

def command(args: list[str]) -> None:
    log("$ " + " ".join(map(str, args)))
    subprocess.run(list(map(str, args)), check=True)

def md5_file(path: Path) -> str:
    digest = hashlib.md5()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(url: str, target: Path, expected_md5: str | None = None) -> None:
    if target.exists() and target.stat().st_size > 0:
        if not expected_md5 or md5_file(target).lower() == expected_md5.lower():
            log(f"Reusing downloaded file {target.name} ({target.stat().st_size:,} bytes)")
            return
        log(f"Existing {target.name} failed its checksum; downloading it again.")
        target.unlink()
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_suffix(target.suffix + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": "RWMapForge-global-terrain-import/1.0"})
    log(f"Downloading {target.name} from {url}")
    with urllib.request.urlopen(req, timeout=120) as response, temp.open("wb") as out:
        total = response.headers.get("Content-Length")
        if total:
            log(f"Remote size: {int(total):,} bytes")
        shutil.copyfileobj(response, out, length=1024 * 1024)
    temp.replace(target)
    if expected_md5:
        actual = md5_file(target)
        if actual.lower() != expected_md5.lower():
            target.unlink(missing_ok=True)
            raise RuntimeError(f"Checksum mismatch for {target.name}: expected {expected_md5}, got {actual}")
    log(f"Downloaded {target.name} ({target.stat().st_size:,} bytes)")

def extract_shapefile(zip_path: Path, out_dir: Path, expected: str) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    if not any(out_dir.rglob("*.shp")):
        log(f"Extracting {zip_path.name}")
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(out_dir)
    candidates = list(out_dir.rglob(expected))
    if not candidates:
        candidates = [p for p in out_dir.rglob("*.shp") if p.stem.lower() == Path(expected).stem.lower()]
    if not candidates:
        raise RuntimeError(f"Could not find {expected} inside {zip_path.name}")
    return candidates[0]

def create_spatial_index(shp: Path) -> None:
    qix = shp.with_suffix(".qix")
    if qix.exists() and qix.stat().st_size > 0:
        return
    layer = shp.stem.replace('"', '""')
    command(["ogrinfo", "-q", str(shp), "-sql", f'CREATE SPATIAL INDEX ON "{layer}"'])
    if not qix.exists():
        raise RuntimeError(f"GDAL did not create the spatial index for {shp.name}")

def r2_client():
    account_id = os.environ.get("R2_ACCOUNT_ID", "").strip()
    access_key = os.environ.get("R2_ACCESS_KEY_ID", "").strip()
    secret_key = os.environ.get("R2_SECRET_ACCESS_KEY", "").strip()
    if not (account_id and access_key and secret_key):
        raise SystemExit(
            "Missing GitHub Actions secrets: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, "
            "R2_SECRET_ACCESS_KEY. Create an R2 Object Read & Write token scoped "
            "only to the rw-map-forge-terrain bucket."
        )
    return boto3.client(
        "s3",
        endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
        region_name="auto",
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
    )

def put_bytes(client, key: str, body: bytes, content_type: str) -> None:
    global _uploaded_bytes
    # Reserve the byte budget under a lock, but upload outside the lock so the
    # tile workers can use R2's throughput in parallel.
    with _upload_lock:
        if _uploaded_bytes + len(body) > MAX_UPLOAD_BYTES:
            raise RuntimeError(
                f"Import would exceed MAX_UPLOAD_GB={MAX_UPLOAD_BYTES / (1024 ** 3):.1f}; "
                "raise the GitHub Actions variable only after reviewing R2 pricing."
            )
        _uploaded_bytes += len(body)
    try:
        client.put_object(
            Bucket=BUCKET,
            Key=key,
            Body=body,
            ContentType=content_type,
            CacheControl="public, max-age=31536000, immutable",
        )
    except Exception:
        with _upload_lock:
            _uploaded_bytes -= len(body)
        raise

def mark_manifest(client, ready: bool, **extra) -> None:
    manifest = {
        "schemaVersion": 1,
        "datasetVersion": "global-v1",
        "ready": ready,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sources": {
            "water": {
                "name": "HydroLAKES v1 lake polygons",
                "url": "https://www.hydrosheds.org/products/hydrolakes",
                "license": "Creative Commons Attribution 4.0 International",
                "attribution": "HydroLAKES (Messager et al., 2016), HydroSHEDS",
            },
            "rivers": {
                "name": "HydroRIVERS v1",
                "url": "https://www.hydrosheds.org/products/hydrorivers",
                "license": "HydroSHEDS product terms; free for scientific, educational and commercial use",
                "attribution": "HydroRIVERS (Lehner & Grill, 2013), HydroSHEDS",
                "filter": "Strahler order >= 3; simplified for game-map scale",
            },
            "roads": {
                "name": "Natural Earth 1:10m roads, version 5.0.0",
                "url": "https://www.naturalearthdata.com/downloads/10m-cultural-vectors/",
                "license": "Public domain",
                "attribution": "Natural Earth, 1:10m cultural vectors",
            },
            "landcover": {
                "name": "MODIS MCD12Q1 v061, 2021 IGBP land-cover class",
                "url": "https://zenodo.org/records/8367523",
                "license": "Derived from NASA LP DAAC MCD12Q1 v061; retain source attribution and the OpenGeoHub record citation. The mosaic record does not surface a separate license label.",
                "attribution": "NASA LP DAAC MCD12Q1 v061; OpenGeoHub global mosaic",
                "sourceResolution": "approximately 1 km",
                "storedResolution": "0.025 degrees (about 2.8 km at the equator)",
                "classMapping": {
                    "1": "forest/trees",
                    "2": "barren/desert",
                    "3": "rock/bare terrain",
                    "4": "urban/built-up",
                    "5": "grass, savanna, wetland and cropland",
                    "6": "snow/ice",
                    "7": "water",
                    "0": "no data",
                },
            },
        },
        **extra,
    }
    put_bytes(
        client,
        f"{PREFIX}/manifest.json",
        json.dumps(manifest, separators=(",", ":"), ensure_ascii=False).encode("utf-8"),
        "application/json",
    )

def ogr_tile(
    client,
    shp: Path,
    source: str,
    x: int,
    y: int,
    degrees: int,
    where: str | None,
    selected_fields: str | None,
    simplify: str,
    temp_dir: Path,
    existing_sizes: dict[str, int],
) -> tuple[bool, int]:
    key = f"{PREFIX}/hydro/{source}/{y}_{x}.geojson.gz"
    if key in existing_sizes:
        return True, existing_sizes[key]

    west = -180 + x * degrees
    south = -90 + y * degrees
    east = west + degrees
    north = south + degrees
    tmp_json = temp_dir / f"{source}-{y}-{x}.geojson"
    if tmp_json.exists():
        tmp_json.unlink()

    args = [
        "ogr2ogr", "-f", "GeoJSON", str(tmp_json), str(shp),
        "-spat", str(west), str(south), str(east), str(north),
        "-clipsrc", str(west), str(south), str(east), str(north),
        "-t_srs", "EPSG:4326",
        "-simplify", simplify,
        "-lco", "RFC7946=YES",
        "-lco", "COORDINATE_PRECISION=4",
    ]
    if where:
        args += ["-where", where]
    if selected_fields:
        args += ["-select", selected_fields]

    proc = subprocess.run(args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    if proc.returncode:
        tmp_json.unlink(missing_ok=True)
        detail = (proc.stderr or "").strip()[-2000:]
        raise RuntimeError(f"ogr2ogr failed for {source} cell {x},{y} (exit {proc.returncode}): {detail}")
    try:
        raw = tmp_json.read_bytes()
        data = json.loads(raw)
        features = data.get("features", [])
        if not features:
            return False, 0
        # Normalize to a compact FeatureCollection and drop all unwanted attributes.
        compact = {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": (feature.get("properties") or {}),
                    "geometry": feature.get("geometry"),
                }
                for feature in features if feature.get("geometry")
            ],
        }
        payload = json.dumps(compact, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        compressed = gzip.compress(payload, compresslevel=9, mtime=0)
        put_bytes(client, key, compressed, "application/gzip")
        existing_sizes[key] = len(compressed)
        return True, len(compressed)
    finally:
        tmp_json.unlink(missing_ok=True)

def build_vector_grid(client, shp: Path, source: str, degrees: int, where: str | None, fields: str | None, simplify: str, temp_dir: Path, existing_sizes: dict[str, int]) -> dict:
    create_spatial_index(shp)
    nx, ny = 360 // degrees, 180 // degrees
    log(f"Building {source}: {nx * ny:,} possible {degrees}° × {degrees}° cells")
    work = []
    stored = 0
    total_bytes = 0
    done = 0
    max_workers = 3
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as pool:
        for y in range(ny):
            for x in range(nx):
                work.append(pool.submit(
                    ogr_tile, client, shp, source, x, y, degrees,
                    where, fields, simplify, temp_dir, existing_sizes
                ))
        for future in concurrent.futures.as_completed(work):
            has_features, byte_count = future.result()
            done += 1
            if has_features:
                stored += 1
                total_bytes += byte_count
            if done % 250 == 0 or done == len(work):
                log(f"{source}: {done:,}/{len(work):,} cells checked; {stored:,} stored; {total_bytes / (1024**2):.1f} MiB compressed")
    return {"gridDegrees": degrees, "possibleCells": nx * ny, "nonEmptyCells": stored, "compressedBytes": total_bytes}

def build_landcover(client, source_tif: Path, temp_dir: Path, existing_sizes: dict[str, int]) -> dict:
    global_tif = temp_dir / "landcover-global-0p025.tif"
    if not global_tif.exists():
        log("Downsampling global MODIS categorical land cover to a 0.025° grid")
        command([
            "gdalwarp", "-overwrite", "-multi", "-wo", "NUM_THREADS=2",
            "-t_srs", "EPSG:4326",
            "-te", "-180", "-90", "180", "90",
            "-tr", str(LAND_RES), str(LAND_RES),
            "-r", "mode",
            "-srcnodata", "255", "-dstnodata", "255",
            "-ot", "Byte",
            "-co", "TILED=YES", "-co", "COMPRESS=DEFLATE", "-co", "PREDICTOR=2",
            str(source_tif), str(global_tif),
        ])

    with rasterio.open(global_tif) as ds:
        if ds.width != 14400 or ds.height != 7200:
            raise RuntimeError(f"Unexpected global raster size: {ds.width} × {ds.height}")
        mapping = np.zeros(256, dtype=np.uint8)
        mapping[1:6] = 1                       # forest classes -> tree mask
        mapping[[6, 7, 8, 9, 10, 11, 12, 14]] = 5  # scrub/savanna/grass/wetland/crops
        mapping[13] = 4                        # urban
        mapping[15] = 6                        # snow/ice
        mapping[16] = 2                        # barren land
        mapping[17] = 7                        # inland water
        mapping[255] = 0                       # nodata

        stored = 0
        total_bytes = 0
        for y in range(18):
            # Binary rows are north-to-south within each 10° tile.
            row_top = (17 - y) * LAND_SIDE
            for x in range(36):
                window = Window(x * LAND_SIDE, row_top, LAND_SIDE, LAND_SIDE)
                data = ds.read(1, window=window)
                mapped = mapping[data]
                compressed = gzip.compress(mapped.tobytes(order="C"), compresslevel=9, mtime=0)
                key = f"{PREFIX}/landcover/{y}_{x}.bin.gz"
                if key in existing_sizes:
                    size = existing_sizes[key]
                else:
                    put_bytes(client, key, compressed, "application/gzip")
                    size = len(compressed)
                    existing_sizes[key] = size
                stored += 1
                total_bytes += size
            if (y + 1) % 3 == 0:
                log(f"Land cover: {stored}/648 tiles uploaded; {total_bytes / (1024**2):.1f} MiB compressed")
    return {
        "tileDegrees": LAND_DEG,
        "resolutionDegrees": LAND_RES,
        "tileSidePixels": LAND_SIDE,
        "tiles": stored,
        "compressedBytes": total_bytes,
        "sourceCoverage": {"west": -180, "south": -62.00081, "east": 179.99994, "north": 87.37},
    }

def list_existing_global_tiles(client) -> dict[str, int]:
    existing: dict[str, int] = {}
    paginator = client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=BUCKET, Prefix=PREFIX + "/"):
        for item in page.get("Contents", []):
            key = item.get("Key")
            if key:
                existing[key] = int(item.get("Size", 0))
    log(f"Found {len(existing):,} existing global R2 objects; valid tile keys will be reused.")
    return existing


def main() -> None:
    client = r2_client()
    work = Path(tempfile.mkdtemp(prefix="rw-map-forge-global-terrain-"))
    temp_dir = work / "tile-tmp"
    temp_dir.mkdir()
    metrics = {"ready": True, "datasetVersion": "global-v1"}
    existing_sizes = list_existing_global_tiles(client)
    mark_manifest(client, False, statusMessage="Global terrain dataset import is running; don't use uncached terrain until ready.")

    try:
        # HydroRIVERS: keep streams of Strahler order >= 3 and simplify for game-map scale.
        zip_path = work / "hydrorivers.zip"
        download(HYDRORIVERS_URL, zip_path)
        rivers_dir = work / "hydrorivers"
        rivers_shp = extract_shapefile(zip_path, rivers_dir, "HydroRIVERS_v10.shp")
        metrics["rivers"] = build_vector_grid(
            client, rivers_shp, "rivers", HYDRO_DEG,
            '"ORD_STRA" >= 3', "HYRIV_ID,ORD_STRA", "0.0015", temp_dir, existing_sizes
        )
        shutil.rmtree(rivers_dir, ignore_errors=True)
        zip_path.unlink(missing_ok=True)

        # HydroLAKES: the source includes lakes/reservoirs >= 10 hectares.
        zip_path = work / "hydrolakes.zip"
        download(HYDROLAKES_URL, zip_path)
        lakes_dir = work / "hydrolakes"
        lakes_shp = extract_shapefile(zip_path, lakes_dir, "HydroLAKES_polys_v10.shp")
        metrics["water"] = build_vector_grid(
            client, lakes_shp, "water", HYDRO_DEG,
            None, "Hylak_id", "0.001", temp_dir, existing_sizes
        )
        shutil.rmtree(lakes_dir, ignore_errors=True)
        zip_path.unlink(missing_ok=True)

        # Natural Earth provides a compact global major-road layer to remove the
        # remaining Overpass dependency from map generation.
        zip_path = work / "natural-earth-roads.zip"
        download(NATURAL_EARTH_ROADS_URL, zip_path)
        roads_dir = work / "roads"
        roads_shp = extract_shapefile(zip_path, roads_dir, "ne_10m_roads.shp")
        metrics["roads"] = build_vector_grid(
            client, roads_shp, "roads", ROAD_DEG,
            None, "ne_id,type", "0.001", temp_dir, existing_sizes
        )
        shutil.rmtree(roads_dir, ignore_errors=True)
        zip_path.unlink(missing_ok=True)

        # MODIS MCD12Q1 2021 IGBP class raster; 156 MB source, compact tile cache output.
        land_tif = work / "modis-landcover-2021.tif"
        download(MODIS_LANDCOVER_URL, land_tif, expected_md5="862010ec14d621333126336a65ee01c5")
        metrics["landcover"] = build_landcover(client, land_tif, temp_dir, existing_sizes)
        land_tif.unlink(missing_ok=True)

        metrics.update({
            "ready": True,
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "statusMessage": "All global terrain datasets were processed and uploaded.",
        })
        mark_manifest(client, True, **{k: v for k, v in metrics.items() if k != 'ready'}, uploadedBytes=_uploaded_bytes)
        log("Import completed successfully. global/v1/manifest.json now marks the local datasets ready.")
        log(json.dumps(metrics, indent=2))
    except Exception as exc:
        log(f"Import failed: {exc!r}")
        mark_manifest(client, False, statusMessage=f"Import failed: {type(exc).__name__}: {exc}")
        raise
    finally:
        shutil.rmtree(work, ignore_errors=True)

if __name__ == "__main__":
    main()
