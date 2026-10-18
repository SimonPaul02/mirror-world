# RF scenario export and trajectory demo

The Odesa trajectory generator is at `/`; the original RF simulation and its
Scenario JSON export are at `/scenario.html`.

## Configure the scenario manually

At `/`, choose **2D map** for drag-to-pan navigation, or **3D globe** to orbit. The navigation pad provides pan, zoom and north reset.

- **Drones:** 1–5, each with its own object ID, starting coordinates and heading. Speed, starting height above surface, duration and output interval are shared. Each route uses the merged terrain-aware engine with a distinct seed and is rejected if it leaves the crop. **Inspect drone** changes the selected state, bearings, metrics and RF downloads; all drone truth routes and estimate trails remain visible.
- **RF receivers:** 0–12 fixed sites. Edit coordinates or **Randomize RF sites in crop**, using the placement seed to reproduce a layout. Randomization samples the original terrain crop with valid coverage and separated sites; it does not optimize placement. Zero receivers produces no RF records; one produces bearings without position fixes. With more receivers, the browser and Python estimator choose a valid measured pair by modeled uncertainty for each timestamp; this is not all-receiver least-squares fusion.
- **Cameras:** 0–5, each at an editable fixed site or mounted on a chosen scenario drone. Fixed sites can also be randomized using the placement seed. Onboard heading is an offset from the host's heading; pitch is relative to horizontal. The ideal pinhole model projects a 2.5 m target into a 1920×1080 frame with a 20° horizontal field of view, checks terrain line of sight, and reports a target only at ≥2 pixels. The host is excluded. Confidence is heuristic; the SVG previews are schematic, without photorealistic terrain, blur or image noise.
- **Satellite sources:** 0–3 configured context feeds. These reference a shared static PNG made from the original DSM hillshade, with footprint, image dimensions, source grid spacing, attribution and scenario timestamps. They are **terrain context, not optical satellite acquisitions**: optical acquisition time is null, there is no orbit model, and no drone detections are invented. The online satellite basemap checkbox only changes the viewer background.

**Manual placement is the default.** Every RF receiver and fixed camera has editable latitude/longitude and a **Place … on map** button. Click inside the terrain crop to set its site; Escape or Cancel exits placement. Drone-mounted cameras use their host drone's position. Random placement is explicitly opt-in through each placement selector and randomize button; changing the sensor count alone never randomizes sites. Satellite sources need no manually positioned ground site.

After changing sensor settings, use **Apply sensor configuration**. Trajectory setting changes require **Generate trajectory** again. The sensor preview selector shows the most recent camera/context frame at or before the replay time. Camera/context records are exported separately and do not feed RF localization. No automatic sensor-set optimization is implemented. Radar and LiDAR are not required by the challenge brief.

**Download complete scenario** exports a version-2 bundle containing all trajectories, per-drone RF scenarios, optional sensor configuration, image assets, synchronized records and answer keys. Each `rf_scenarios` entry retains the version-1 single-object format; RF observation IDs are scoped by that entry's `scenario_id`, so use `(scenario_id, observation_id)` across the bundle. Selected-drone RF JSON and TAK downloads remain standalone. Separate configured transmitter frequencies (5 MHz spacing) assume ideal emitter/channel separation; multi-target RF association and interference are not modeled.

## Validate RF against the merged Odesa trajectory

```
npm run demo:odesa-rf
```

This runs the team's five-minute trajectory engine, converts its EGM2008 altitude using the matching geoid, and feeds the actual 300 sampled positions to the RF generator. RF propagation samples the original checked Copernicus DSM and geoid directly; no streamed viewer tiles or synthetic ridge are used. Because the DSM already includes buildings/vegetation, this configuration adds no extra blanket clutter height. Terrain paths are sampled at about 30 m spacing.

`examples/rf_sensor_odesa.json` defines two illustrative sites at `(lat 46.48, lon 30.60)` and `(lat 46.40, lon 30.61)`, each with a 12 m mast. They are about 8.9 km apart and yield crossing angles of about 41–87 degrees on the default route. These are scenario placements, not surveyed real RF installations. Change the coordinates/settings to test another layout.

The default run gives 600 detections and 300 bearing fixes. Its high flight path clears the low-relief terrain: no terrain dropout is fabricated. With the current heuristic RF noise assumptions, raw position RMSE is about 628 m and filtered RMSE about 293 m. These are simulated errors, not measured hardware accuracy.

`outputs/odesa/` contains the full RF scenario and answer keys, original/source trajectory JSON, `sensor_trace.cot`, a CoT record-to-object answer key, raw fixes, the estimated track, metrics, an RF behavior plot, a trajectory comparison plot, and `validation.json`. The final validation cross-checks JSON versus XML values, exact timestamps, observation IDs, answer keys, and tracker measurement provenance. Each detected receiver reading has a CoT event; aggregate fixes carry their contributing signals. Fixed receiver sites remain valid through the capture. The original UTC start is preserved.

To see and position receivers on the same flight, open `http://localhost:3000/`, click **Generate trajectory**, and use **RF RECEIVERS** to edit the sites and **Apply sensor configuration**. Mint marks sites, yellow lines show measured bearings, and cyan shows the true trajectory. Scrubbing the timeline replays the corresponding RF observations. Download RF JSON or TAK XML for the current trajectory and receiver settings. The viewer displays instantaneous fixes; the independent Kalman track remains in the CLI report.

RF estimates accumulate as dots and connected segments through the current replay timestamp. Each new segment and current fix is colored by horizontal distance from the same timestamp's truth: green at ≤100 m, yellow at 500 m, and red at ≥1,000 m, with continuous interpolation. The fixed scale makes runs comparable. The panel shows current horizontal error and cumulative horizontal RMSE over visible valid fixes (about 628 m for the complete default raw RF run). Missing fixes leave gaps; rewind/restart hides future points, and changing receiver sites or trajectory settings rebuilds or clears the trail. Truth is used only to evaluate/color the sensor-derived positions.

`npm run test:odesa-rf` checks the actual producer contract, shared height datum, complete real-terrain coverage, TAK trace identities/timestamps, and receiver geometry. A deliberately near-coincident baseline is rejected for unstable geometry. The controlled synthetic-ridge tests remain separate and demonstrate obstruction/dropout behavior that the default high-altitude Odesa route does not exhibit.

## Run the one-minute mock now

Use Node 22.18+ and the Python dependencies below. The pulled terrain tests import TypeScript directly and need a recent Node runtime. After `npm ci`:

```
npm run demo:rf
```

This imports `examples/drone_trajectory_mock_60s.json` in Arda's proposed format, places two receivers 3 km apart using `examples/rf_sensor_config.json`, and generates RF records at simulation seconds 0–59. The drone follows a gentle curve at about 30 m/s and 200 m above the synthetic terrain beneath its flight. The coordinates are in Ukraine, but the demonstration ridge is explicitly synthetic. RF2's missing readings result from terrain attenuation and its configured sensitivity, not a scripted timer.

Open `outputs/mock_60s/trajectory_comparison.png` to compare truth, bearing intersections, and the filtered trajectory. Open `outputs/mock_60s/rf_behavior.png` to see RF power, detection thresholds, and terrain attenuation. The same directory contains:

- `scenario.json`: receiver definitions, actual sample clock, truth, detected observations, missed-detection diagnostics, and separate answer keys.
- `sensor_report.json`: detection counts, receiver baseline, crossing angles, and challenge-readiness warnings.
- `rf_validation.json`: measured clear-path versus ridge checks, distance-loss checks, and perfect-bearing geometry error.
- `bearing_fixes.json`, `estimated_track.json`, and `metrics.json`: independent sensor-derived positions, track states, and truth-comparison metrics.
- `rf_diagnostics.json`: simulated link-budget components for plotting and model inspection. These are simulator diagnostics, not additional measured channels.

This one-minute mock is for development. A final challenge scenario still needs real Ukrainian elevation and a duration of a few minutes or longer.

Replace the mock with Arda's file without changing the sensor model:

```
npm run generate:rf -- --trajectory /path/to/drone_trajectory.json --config examples/rf_sensor_config.json --output outputs/arda
python3 -m rf_fusion.cli --scenario outputs/arda/scenario.json --output outputs/arda --diagnostics outputs/arda/rf_diagnostics.json
```

Receiver positions, heights, gains, noise floors, and bearing errors are configurable in the sensor JSON. `--terrain /path/to/grid.json` accepts a rectangular grid with `kind: "grid"`, `source`, `real_terrain`, `height_reference: "ellipsoid"`, `south_lat`, `west_lon`, positive `step_lat_deg`/`step_lon_deg`, and `heights_hae_m` rows running south to north. Convert orthometric DEM heights to ellipsoidal heights before supplying the grid; the generator rejects missing coverage instead of inventing readings.

Run `npm run test:sensors` and `python3 -m pytest -q` for the sensor and tracking checks. `npm run mock:trajectory` reproducibly regenerates the mock input.

## Generate a scenario in the app

Install with `npm ci`, then run `npm run dev`. Open a URL such as:

```
http://localhost:3000/scenario.html?seed=42&route=full&duration_s=180&sample_s=2
```

`route` accepts `full`, `south`, or `varied`. The `varied` option perturbs the Donbas waypoints and altitudes from the seed, producing a different flight path; `seed` also controls RF noise. `duration_s` is 120–21600 seconds; `sample_s` is 1–60 seconds. The defaults are the full Donbas route, seed 20261103, 180 seconds, and 2-second samples. Press **T** to speed up the simulation. After it has run for a few minutes, press **Scenario .json** in the TAK panel.

The JSON includes receiver positions, the shared sample clock, drone truth, RF observations, missed-detection diagnostics, and an `observation_id` → `source_object_id` answer key. Missing-detection diagnostics have their own record-to-object answer key. `bearing_deg` is clockwise from the scenario origin's North; `sensor_bearing_deg` preserves the receiver's original local true-north azimuth. The app's local coordinates are metres east/north of RF1. Unknown terrain produces missing-data diagnostics rather than valid detections. The app shows export validation warnings for short captures, missing terrain, and broken record relationships.

The separate Donbas viewer at `/scenario.html` still flies its built-in route. The main Odesa viewer at `/` now uses the merged trajectory with the RF overlay described above. The one-minute mock remains a separate reproducible development example.

The browser must actually load real terrain for a challenge-ready capture. The export says whether the provider was real and how much of each RF path had sampled terrain. If tiles were absent, attenuation is approximate and the app warns about it. The scenario's current route/terrain integration is a working starting point for Ard's trajectory and Simone's terrain choices.

## Estimate from the exported RF records

Python 3.11+ with NumPy, Pillow, and Pytest:

```
python -m pip install -r requirements_rf_fusion.txt
python -m rf_fusion.cli --scenario examples/scenario_2d_fixture.json --output outputs/demo
python -m pytest -q
```

Replace the fixture path with a downloaded scenario JSON to analyze the live generator output. The CLI writes `estimated_track.json`, `metrics.json`, and `trajectory_comparison.png`. It prints the number of intersections, prediction-only frames, and RMSE when truth is available.

`estimate_track` receives only sensors, bearing observations, and the sample clock. It never reads ground truth or associations. Two receiver bearings intersect as forward rays in 2D local east/north metres. Their reported bearing uncertainties and geometry determine the filter's measurement covariance; legacy inputs without uncertainty assume 1 degree. A constant-velocity Kalman filter predicts during missing or unusable readings and rejects grossly inconsistent fixes using an innovation gate. `prediction_reason` distinguishes missing receivers, bad geometry, and rejected fixes. The evaluation step compares the resulting track to truth afterward.

Each estimator input represents one drone and supports 0–12 configured AoA-capable receivers; at least two usable bearings are needed to initialize a position track. Multiple drones are exported as separate RF scenarios in the complete bundle. One ordinary omnidirectional RSSI measurement does not provide a bearing. Altitude, terrain, weather, and multi-object association are outside the estimator; the simulator still uses drone altitude and terrain when producing RF measurements.
