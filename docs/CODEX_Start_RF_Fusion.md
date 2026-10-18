# Paste this directly into Codex in VS Code

Implement my **2-hour Mirror World RF localization subsystem** according to `Mirror_World_RF_Fusion_2_Hour_Implementation_Brief.md` and `scenario_2d_fixture.json` in this workspace. Inspect the existing repository first; integrate conservatively without overwriting teammates' work.

## Context

Our team is building a synthetic aerial sensor scenario generator. **I own the downstream 2D estimation module**, which proves that the generated RF detections can reconstruct the simulated drone's trajectory. The generator team owns ground truth, 2 RF sensor poses, and timestamped simulated measurements. Track estimation is a bonus validation module, not the generator itself.

## Hard constraints — do not expand scope

- One drone, two stationary RF receivers capable of generating angle-of-arrival (AoA) **bearings**; assume 2D only, 1 Hz, no weather, no terrain occlusion for the first end-to-end pass.
- Coordinate frame: local ENU in **metres**; `x` East, `y` North. Bearing degrees increase **clockwise from North** (0=N, 90=E).
- Use Python 3.11+, NumPy, Matplotlib, Pytest. Avoid SciPy, GUI/SaaS, TAK, 3D, GIS, cameras, radar, multi-drone association, or a splines subsystem.
- Input JSON schema is in the brief/fixture; preserve `frequency_mhz` and `power_dbm` but **triangulate using bearings only**.
- The tracker must NEVER access ground truth or the `associations` answer key. Pass ground truth only to post-hoc evaluation.

## Implementation stages, in order

1. **Geometry.** `bearing_to_unit(deg) = [sin(deg),cos(deg)]`. Implement intersection of the *forward rays* from two RF sensors. Reject near-parallel/antiparallel cases using `abs(cross(u1,u2))<0.15`, intersections with a negative distance along a ray, and non-finite/range-invalid results. Mandatory exact test: RF1 `(0,0)` bearing 45° and RF2 `(6000,0)` bearing 315° must yield `(3000,3000)` metres.
2. **Timing and fusion.** Pair the two AoA readings from the same timestamp; missing sensor → no new 2D measurement. Do not use RSSI as a substitute bearing. One drone only, so no object matching logic.
3. **Tracking.** Build a constant-velocity Kalman filter with state `[px,py,vx,vy]`. Initialize at first valid triangulation; predict every timestep, update when a valid intersection exists; during dropouts mark the result `prediction_only`. Use a reasonable fixed observation covariance initially; allow it to be tuned later.
4. **Evaluation.** Compare estimates with truth only after tracking. Output RMSE/MAE/max 2D error and counts: frames, triangulations, measurement-update frames, prediction-only frames. Produce comparison plot with sensor sites, true trajectory, triangulated points, and filtered trajectory (equal XY axis scale).
5. **CLI, artifacts, tests, docs.** Support:

   ```bash
   python -m rf_fusion.cli --scenario examples/scenario_2d_fixture.json --output outputs/demo
   python -m pytest -q
   ```

   Create:
   ```text
   outputs/demo/estimated_track.json
   outputs/demo/metrics.json
   outputs/demo/trajectory_comparison.png
   ```

   Include tests for cardinal directions, exact triangle geometry, degenerate lines, invalid forward rays, missing bearings, deterministic end-to-end run, and *no ground-truth leakage*. Add a concise `README_RF_FUSION.md` with install/run commands, JSON schema, limitations, and output examples.

## Definition of complete

The commands above must actually run. Finish with a concise status showing files changed, number of passing tests, actual measured RMSE, whether RF2 dropout (t=10–14 s) correctly causes prediction-only output, and remaining integration requirements from the other team. If the repo lacks the fixture in `examples`, copy the supplied `scenario_2d_fixture.json` there.

**Prioritize a working complete pipeline over elegance; do not spend time on features outside the scope.**
