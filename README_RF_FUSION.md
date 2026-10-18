# RF scenario export and trajectory demo

The Odesa trajectory generator is at `/`; the original RF simulation and its
Scenario JSON export are at `/scenario.html`.

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

The live Cesium viewer currently flies the built-in Donbas route. The separate one-minute mock above produces data and plots; it is not yet connected to the live viewer.

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

This estimator assumes one drone and exactly two AoA-capable receivers. One ordinary omnidirectional RSSI measurement does not provide a bearing. Altitude, terrain, weather, and multi-object association are outside the estimator; the simulator still uses drone altitude and terrain when producing RF measurements.
