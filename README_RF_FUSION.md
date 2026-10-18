# RF scenario export and trajectory demo

## Generate a scenario in the app

Install with `npm ci`, then run `npm run dev`. Open a URL such as:

```
http://localhost:5173/?seed=42&route=full&duration_s=180&sample_s=2
```

`route` accepts `full`, `south`, or `varied`. The `varied` option perturbs the Donbas waypoints and altitudes from the seed, producing a different flight path; `seed` also controls RF noise. `duration_s` is 120–21600 seconds; `sample_s` is 1–60 seconds. The defaults are the full Donbas route, seed 20261103, 180 seconds, and 2-second samples. Press **T** to speed up the simulation. After it has run for a few minutes, press **Scenario .json** in the TAK panel.

The JSON includes receiver positions, the shared sample clock, drone truth, RF observations, missed-detection diagnostics, and an `observation_id` → `source_object_id` answer key. The observations contain measured bearings clockwise from North and signal power. The local coordinates are metres east/north of RF1. Truth is separate from the sensor observations. The app shows export validation warnings for short captures, missing terrain, unsampled RF paths, and broken record relationships.

The browser must actually load real terrain for a challenge-ready capture. The export says whether the provider was real and how much of each RF path had sampled terrain. If tiles were absent, attenuation is approximate and the app warns about it. The scenario's current route/terrain integration is a working starting point for Ard's trajectory and Simone's terrain choices.

## Estimate from the exported RF records

Python 3.11+ with NumPy, Pillow, and Pytest:

```
python -m pip install -r requirements_rf_fusion.txt
python -m rf_fusion.cli --scenario examples/scenario_2d_fixture.json --output outputs/demo
python -m pytest -q
```

Replace the fixture path with a downloaded scenario JSON to analyze the live generator output. The CLI writes `estimated_track.json`, `metrics.json`, and `trajectory_comparison.png`. It prints the number of intersections, prediction-only frames, and RMSE when truth is available.

`estimate_track` receives only sensors, bearing observations, and the sample clock. It never reads ground truth or associations. Two receiver bearings intersect as forward rays in 2D local east/north metres. A constant-velocity Kalman filter predicts during missing or unusable readings; it does not invent observations. The evaluation step compares the resulting track to truth afterward.

This estimator assumes one drone and exactly two AoA-capable receivers. One ordinary omnidirectional RSSI measurement does not provide a bearing. Altitude, terrain, weather, and multi-object association are outside the estimator; the simulator still uses drone altitude and terrain when producing RF measurements.
