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

Run `npm run dev` and open http://127.0.0.1:3000/ for the Odesa replay.
The dev/build preparation script packages the rasters, manifest, geoid and
initial form defaults in ignored `public/trajectory/`. It also writes a CLI
example export for independent consumers; the map does not load that export.
`inputs/odesa.example.json` supplies initial defaults, and all subsequent run
parameters come from the UI. Editing defaults requires preparation and refresh;
changing UI settings does not.

Use **Configure run → Generate trajectory → Play**. Select seed 42 or 43 presets,
edit the numerical inputs, or choose **New seed**. Expand **Timing and turning**
for the UTC start, export interval, turn limit and heading-command interval.
The presets use the packaged defaults with different seeds, and do not contain
stored routes. The terrain stays Odesa. Minimum clearance and rejection rules
are fixed by the packaged contract; longer runs can leave the finite crop.

`src/trajectory-worker.ts` validates the UI payload, verifies the elevation hash,
loads the raster once, and calls `engine/trajectory-core.mjs`. That same core is
wrapped by the Node CLI in `engine/trajectory.mjs`. Shared validation and raster
sampling run in both environments. Browser provenance uses Web Crypto SHA-256;
serve on localhost or HTTPS. Tests compare the worker's complete export with
the CLI, including hashes, and exercise changed inputs and rejected paths.

Generating never starts playback automatically. Editing inputs clears the
previous route, disables playback/download, and requires generation again.
Failures show the engine error and elapsed time where available. Cancellation
terminates the worker; a later request starts a fresh worker. This works in both
Vite development and the static production build, without a generation API.

The map provides play/pause, restart, scrubbing, 1/5/20/60x speed, overview,
aircraft following, local hillshade and optional online satellite imagery.
The JSON download is the current successful engine export with `resolved_input`.
The terminal validation state is appended only in the player to display the
final interval. Between exported samples, position/heading are interpolated for
display; displayed clearance is resampled from the local DSM. No new truth
states or sensor outputs are emitted during playback.

The local terrain provider samples the numeric DSM into Cesium heightmap tiles.
Both terrain and aircraft display heights use `h = H_EGM2008 + N`, with `N`
bilinearly sampled from the bundled 13x13 crop of the NGA EGM2008 2.5-minute
grid (public domain, distributed by PROJ). JSON truth remains EGM2008.
`scripts/fetch-geoid.mjs` reproduces the crop; after deliberate regeneration,
verify the source and update the asset checksum in the manifest.

The map uses actual relief (1x); Odesa's surface is relatively flat. Terrain
rendering is level-of-detail resampled, while clearance readings use the full
DSM. Beyond the amber footprint the globe is flat, without measured local
terrain. The dataset edge is not blended into another terrain source. Local
hillshade NoData is transparent and is never interpreted as a water mask.
The default map and replay need no external service after package installation.
Satellite imagery requires internet. The previous browser scenario remains at
`/scenario.html` with its original terrain provider.

The geoid crop's source and metadata are in `odesa/geoid-egm2008.json`;
[PROJ's source and license notice](https://cdn.proj.org/us_nga_README.txt).
This conversion does not establish survey-grade accuracy.

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

## Receiver ground-truth adapter

After generating in the map, **Download receiver ground truth** exports exactly
`scenario_id`, `sample_period_s` and `ground_truth`. Set **Scenario ID** and
**Object ID** before generating. The full trajectory/provenance export remains
available as a second download. Both downloads are invalidated by input changes.

Each receiver sample contains `timestamp_s`, `object_id`, `lat`, `lon`, `hae_m`.
The contract is recorded in `receiver-ground-truth.schema.json`:

- `timestamp_s` is elapsed seconds from scenario start, not Unix time. The UTC
  epoch remains in the full export's `resolved_input.simulation.start_time`.
- `sample_period_s` equals the selected export interval, not playback speed or
  the internal integration step. Samples begin at zero; the separate terminal
  validation state is excluded. A 300-second run at 1 Hz exports t=0…299.
- Coordinates are WGS84 decimal degrees; IDs are preserved.
- `hae_m = altitude_egm2008_m + N(lon, lat)`, where N is bilinearly sampled from
  the checksum-verified local EGM2008 geoid crop. No constant offset or surface
  clearance substitution is used. Out-of-grid/nonfinite values are rejected.
- The adapter requires a validated trajectory in the expected CRS and regular
  time spacing. Structural schema validation alone does not check time cadence.
- The receiver export does not carry the source provenance fields; retain its
  full trajectory export alongside it when provenance is needed.

CLI conversion (default scenario ID `ukraine_demo_001`):

```bash
npm run trajectory:generate
npm run trajectory:export-receiver
# Optional explicit source, scenario ID and destination:
npm run trajectory:export-receiver -- terrain/generated/trajectory_truth.json ukraine_demo_002 /tmp/ground_truth.json
```

Default output: `terrain/generated/ground_truth.json`. A failed conversion exits
nonzero and leaves any earlier output unchanged. The CLI and browser worker use
`engine/receiver-adapter.mjs`; the CLI's bundled geoid covers the Odesa area only.
The contract above is implemented and tested; no external receiver has been
exercised in this repository.
