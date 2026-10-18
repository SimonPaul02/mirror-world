# Odesa terrain and trajectory engine

Generate repeatable synthetic `trajectory_truth` JSON from the packaged Odesa
surface model and a JSON configuration. This is a generic kinematic model with
declared assumptions. It is not calibrated to MQ-9 performance.

## Run

```bash
npm install
npm run terrain:validate
npm run trajectory:generate
npm run terrain:test
```

The default input is `terrain/inputs/odesa.example.json`; output is written to
`terrain/generated/trajectory_truth.json`. The example exports 300 states over
five minutes and validates the final interval through 300 seconds. Generated
files are gitignored and reproducible.

Custom input and output paths:

```bash
npm run trajectory:generate -- terrain/inputs/odesa.example.json /tmp/trajectory_truth.json
```

The input's `terrain_manifest` path is relative to the input file. Asset paths
are relative to the manifest. CLI input and output paths are relative to the
working directory. Asset hashes are checked before generation.

A successful run exits 0 and prints the output location and minimum sampled
surface clearance. A failed run exits 1 with a structured error; path errors
include the failing time and coordinates. No partial export is written. An
existing output from an earlier successful run is preserved on failure, so
consumers must check the exit status before using the output file.

## Files

| File | Purpose |
| --- | --- |
| `odesa/elevation.tif` | Numeric DSM extracted unchanged from `rasters_COP30.tar.gz/output_hh.tif` |
| `odesa/hillshade.tif` | Visualization extracted unchanged from `viz.tar.gz/viz.hh_hillshade.tif` |
| `odesa/manifest.json` | Actual grid bounds, altitude reference, inspection results, provenance and checksums |
| `inputs/odesa.example.json` | Initial state, time settings, movement assumptions and output contract |
| `engine/config.mjs` | Shared input validation and asset integrity checks |
| `engine/terrain.mjs` | GeoTIFF reader and bilinear surface sampler |
| `engine/trajectory.mjs` | Deterministic synthetic movement and path validation |
| `generate.mjs` | CLI with atomic JSON export |
| `validate.mjs` | Input and asset checks without generating a trajectory |
| `tests/engine.test.mjs` | Sampling, movement, reproducibility and rejection tests |

## Input and movement semantics

The example starts at an explicit position with constant ground speed and
constant EGM2008 altitude. All movement values are demo assumptions.

- The engine starts with the configured heading. At time zero and each
  `heading_change_interval_s`, Mulberry32 draws a heading command uniformly
  from `[0, 360)`. The aircraft turns toward it along the shortest signed
  angular difference, bounded by `max_heading_rate_deg_s`. An exact 180-degree
  difference uses the negative direction. Turn rate can change at command
  boundaries; there is no bank, inertia, wind or fuel model.
- The fixed simulation clock advances every 0.1 seconds. Movement uses the
  midpoint heading for each step on a sphere of radius 6,371,008.8 metres.
  WGS84 longitude/latitude labels identify positions; the displacement model
  is explicitly a spherical approximation, not ellipsoidal geodesic dynamics.
- The engine subdivides each clock tick when needed so the modeled step
  distance is at most half the smaller terrain grid spacing. It checks bounds,
  availability and surface clearance at every resulting position.
- Changing the export interval does not change the simulated path or random
  draws. Identical inputs, assets and engine version produce identical JSON
  in the same JavaScript runtime. No wall-clock timestamp is inserted.
- Durations and both time intervals must be positive multiples of 0.1 seconds.
  Duration must be strictly less than 86,400 seconds. Output is limited to
  200,000 states and integration to 2,000,000 steps to bound resource usage.
- Output times include the start and exclude the end. The default produces
  states at 0 through 299 seconds. The terminal position at 300 seconds is
  also checked and included in the validation summary.
- Bounds and clearance failures reject the run. There is no automatic steering
  away from boundaries, altitude correction, clipping, wrapping or retry.
  Longer runs and other seeds can therefore fail within this finite crop.

## Elevation and sampling

- Horizontal coordinates: WGS84, EPSG:4326, decimal degrees.
- Surface and aircraft elevations: EGM2008 orthometric height, EPSG:3855, metres.
- Horizontal CRS is encoded in the TIFF. Vertical reference is recorded from
  provider documentation, with that evidence type explicit in the manifest.
- The DSM includes vegetation and buildings. Output therefore uses the name
  `height_above_surface_m`.
- Initial absolute height equals sampled surface height plus the requested
  initial surface clearance. That absolute height stays fixed throughout the
  run; clearance varies with surface elevation.

The raster is 1,440 by 1,440 samples at 1 arc-second spacing. It uses
PixelIsPoint, so its tie point is the first sample center. The hillshade uses
PixelIsArea; its corner origin differs by half a pixel but the centers align.
The engine reads the numeric raster directly, checks its transform against the
manifest, and bilinearly samples within the actual sample-center bounds.
The requested rounded crop `[30.55, 46.30, 30.95, 46.70]` is not substituted for
those actual bounds.

All 2,073,600 packaged elevation values are finite and no NoData tag is present.
About 39.07% equal zero. Finite values do not establish valid land coverage.
Zero and negative elevations are preserved. Explicit NoData values and
nonfinite values needed for interpolation are rejected. No authoritative water
mask is supplied; the hillshade's zero-valued NoData pixels are not used as an
elevation mask.

Surface-clearance checks are sampled, including between exported states. They
are not a proof of continuous clearance or source-data accuracy.

## Output and integration

The exported object contains `trajectory_truth`, `resolved_input`, `engine`,
`coordinates`, `provenance`, `validation` and `limitations`. Each state contains:

```text
timestamp, elapsed_s, object_id
longitude_deg, latitude_deg
altitude_egm2008_m, surface_elevation_egm2008_m, height_above_surface_m
ground_speed_mps, heading_deg
```

Provenance includes hashes of the elevation bytes and serialized configuration
and manifest. The versioned model and numerical assumptions are exported too.

The browser still uses its existing AWS Terrain Tiles provider and scenario.
This engine is callable independently and has no sensor or position-estimation
outputs. Before connecting its altitude values to Cesium or CoT HAE, implement
an explicit EGM2008-to-ellipsoidal-height conversion. No geoid grid or vertical
conversion is bundled.

## Provenance and attribution

- [OpenTopography dataset page](https://portal.opentopography.org/raster?opentopoID=OTSDEM.032021.4326.3), including its Coordinates section.
- [Copernicus specifications and usage notices](https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM).

OpenTopography identifies its hosted dataset as DGED 2023_1. That release and
the vertical reference are provider-documented, not encoded in the inspected
TIFF tags. Documentation checked on 2026-10-18. The manifest records source
archive and member checksums; the original archives remain in Downloads.

© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided
under COPERNICUS by the European Union and ESA; all rights reserved.

Data accessed through OpenTopography. Retain provider attribution with
redistributed data and derived demonstrations.
