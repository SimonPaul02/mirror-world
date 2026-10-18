# Mirror World Hackathon — 2-Hour Implementation Brief
## Your responsibility: 2D RF localization, trajectory estimation, evaluation, and handoff

**Priority:** working end-to-end implementation by the next milestone.  
**Scenario:** one moving drone, two fixed RF angle-of-arrival (AoA) receivers, 2D local coordinates, no weather, no terrain attenuation in the first iteration.  
**Target runtime:** 120 minutes.  
**Target language:** Python 3.11+; NumPy, Matplotlib, Pytest only.  
**Deliverable to teammates:** importable localization/tracking module, demonstrated on timestamped RF readings, a reproducible validation report and plot, and a clear input/output contract.

---

## 0. Challenge versus your subsystem: do not confuse the two

**What the hackathon brief actually requires:** a *scenario generator* that accepts a prompt/configuration and returns (a) the truth of where everything was; (b) timestamp-synchronized synthetic sensor records, including at least a radio signal trace; and (c) an association of each sensor record with the object that caused it. Set the scenario on **real terrain somewhere in Ukraine**. The brief does **not** require an estimated trajectory, Kalman filtering, a SaaS UI, 3D rendering, or TAK export. The repository and a short explanation/presentation are required. The brief's “two receivers a few kilometres apart” example is explicitly inspiration, not a strict requirement.

**What your team has assigned you:** a *downstream consumer / demonstration* of the generated data: turn simultaneous, imperfect bearings from two receivers into estimated 2D drone positions and a smoothed time series, and quantify errors against the generator's hidden ground truth. This is a useful bonus because it proves that sensor records from the simulated world behave coherently.

**Critical distinction:** Do not let ground truth or simulator-only `source_object_id` leak into the localization/tracking algorithm. Ground truth is for *evaluation only*. In a one-drone MVP, data association is unambiguous by assumption; multi-drone association is out of scope.

**2D-first is the correct decision.** You can extend it later, but two azimuth bearings alone cannot resolve altitude. A 3D position estimator would require elevation angles, other sensor types, or explicit height assumptions. Do not promise that 2D → 3D is purely adding a `z` coordinate.

---

## 1. Your definition of done — by minute 120

The milestone passes only if ALL of the following work:

- [ ] Accept a JSON scenario with two receiver positions and time-stamped bearings, using agreed global coordinates.
- [ ] Independently localize the drone by intersecting **two rays**, not by reading ground truth.
- [ ] Track the drone across timestamps using a simple **constant-velocity Kalman filter** (or a very basic smoother if absolutely necessary).
- [ ] Handle occasional **missing or unusable bearings** by predicting from the filter, not fabricating observations.
- [ ] Export `estimated_track.json` with timestamps, estimated `(x,y)`, and `measurement_update` or `prediction_only` status.
- [ ] Export `metrics.json` with localization/tracking error relative to ground truth (e.g., RMSE) and coverage counts.
- [ ] Export `trajectory_comparison.png` showing sensor sites, true trajectory, raw intersections, and filtered trajectory.
- [ ] Add deterministic tests for perfect geometry, noisy measurements, bad geometry, and dropout.
- [ ] Run end-to-end from one documented CLI command, including a fallback fixture if teammates have not yet delivered their sensor generator.
- [ ] Commit the code and send the exact expected input contract to teammates.

**Not needed in your two hours:** a GUI/SaaS, imagery, radar, satellite, real RF hardware, simulation of radio waves in a 3D engine, terrain occlusion calculations, interpolating trajectories with splines, TAK/CoT export, multi-target tracking, data association algorithms, or ML models.

---

## 2. Two-hour timeline and checkpoints

| Time | Task | Concrete result | Cut line |
|---|---|---|---|
| **0–15 min** | Freeze teammate interfaces and create project skeleton. | JSON example, coordinate/time conventions, basic CLI. | If waiting for teammates, use supplied synthetic fixture immediately. |
| **15–45 min** | Write geometry and 2D triangulation. | One correct position per synchronized pair of bearings + tests. | Validate perfect geometry first; avoid premature abstractions. |
| **45–80 min** | Build constant-velocity Kalman tracking. | A timestamped, smooth position estimate; prediction across missing measurements. | No splines; no nonlinear Bayesian filter needed. |
| **80–105 min** | End-to-end wiring: JSON → intersections → tracker → export → plot. | Runnable 30-second scenario; ground-truth comparison and RMSE. | Keep plotting simple (Matplotlib). |
| **105–115 min** | Add robustness tests and integrate teammates' real synthetic readings if ready. | Passed `pytest` and meaningful error/case handling. | Real scenario wiring may slip, but a complete fallback demo must still work. |
| **115–120 min** | Commit, demo, send handoff. | Git commit + CLI command + chart + two-sentence explanation of value. | No new features. |

**Milestone halfway (minute ~60):** triangulation and at least two geometry unit tests must work.  
**Milestone at minute ~105:** repeatable CLI + track + plot + RMSE must work even with only fallback data.

---

## 3. Interface: agree this contract immediately

### 3.1 Coordinate reference and timing

Use **local ENU coordinates in metres** (East, North, Up). For this 2D phase:

- `x_m`: metres **East** of a defined origin.
- `y_m`: metres **North** of the same origin.
- `bearing_deg`: global azimuth measured **clockwise from North**, range `[0,360)`.
  - `0°` = North (+Y); `90°` = East (+X); `180°` = South; `270°` = West.
- `timestamp_s`: seconds since scenario start. Both sensors must use this same clock. Use synchronized **1 Hz** records for the MVP; avoid mismatched clocks.
- Heights/altitudes and geodetic-to-ENU conversion belong to the team's world/terrain generator in a later phase. Do **not** mix degrees of latitude/longitude with metre-scale `x/y` inside geometry.
- A receiver's `bearing_deg` must already be expressed in the **global north-referenced frame**. If hardware/simulator delivers *local* bearing relative to antenna yaw, convert before feeding the estimator: `(local_bearing_deg + sensor_yaw_deg) % 360`.

**Assumption that MUST be confirmed:** each RF receiver supplies an **angle-of-arrival estimate**. An ordinary omnidirectional radio measuring only frequency and RSSI cannot directly report bearing. If teammates can generate only RSSI/frequency, your two-ray triangulation method will not work without additional assumptions or hardware model.

### 3.2 Stable single-file JSON scenario contract

Ask the simulation team to produce this structure (or adapt it once, at the I/O layer, without changing your algorithms):

```json
{
  "scenario_id": "ukraine_demo_001",
  "world_frame": {
    "type": "local_enu",
    "distance_unit": "m",
    "time_unit": "s",
    "bearing_convention": "clockwise_from_north",
    "origin_lat": 49.3754,
    "origin_lon": 31.1882
  },
  "duration_s": 30,
  "sample_period_s": 1.0,
  "sensors": [
    {"id": "RF1", "type": "rf_aoa", "x_m": 0.0, "y_m": 0.0},
    {"id": "RF2", "type": "rf_aoa", "x_m": 6000.0, "y_m": 0.0}
  ],
  "observations": [
    {
      "id": "obs_0001",
      "timestamp_s": 0.0,
      "sensor_id": "RF1",
      "bearing_deg": 45.0,
      "frequency_mhz": 2437.5,
      "power_dbm": -92.6
    },
    {
      "id": "obs_0002",
      "timestamp_s": 0.0,
      "sensor_id": "RF2",
      "bearing_deg": 315.0,
      "frequency_mhz": 2437.5,
      "power_dbm": -92.6
    }
  ],
  "ground_truth": [
    {"timestamp_s": 0.0, "object_id": "D1", "x_m": 3000.0, "y_m": 3000.0}
  ],
  "associations": [
    {"observation_id": "obs_0001", "source_object_id": "D1"},
    {"observation_id": "obs_0002", "source_object_id": "D1"}
  ]
}
```

**Important:** `ground_truth` and `associations` are *scenario-generator outputs*. Pass only `sensors` + `observations` + time metadata into `estimate_track(...)`; use ground truth **only afterward** in `evaluate_track(...)`. `frequency_mhz` and `power_dbm` must be preserved in the dataset, but the first bearing-only estimator need not use them. No observation record means “no detection”; do not manufacture a bearing of `0°`.

### 3.3 What to request from teammates

| Needed from team | Producer | Why your algorithm needs it |
|---|---|---|
| Receiver IDs and ENU positions | World/scenario generator | Origins of bearing rays. |
| Timestamped global-azimuth readings, one per receiver when detected | RF sensor simulator | Inputs for intersecting two rays. |
| Shared time origin and sample period | World/sensor generator | Lets you pair readings without fusing different moments. |
| Ground-truth `(t,x,y,object_id)` | Drone-trajectory generator | Offline RMSE/plots only, never tracking input. |
| Association of `observation_id → source_object_id` | World/sensor generator | Required by hackathon outputs; **not used** by your one-drone estimator. |
| Whether sensor outputs are global AoA or relative to local yaw | RF sensor simulator | Prevents 90°/180° frame errors. |
| Optional: expected bearing noise standard deviation | RF simulator | Helps tune measurement uncertainty. |

**Ready-to-send teammate message:**

> For my 2D localization module, please provide two fixed RF receiver poses `(id, x_m, y_m)` in local ENU metres, and per-timestamp RF AoA readings `(id, timestamp_s, sensor_id, bearing_deg)` with bearings clockwise from global North. Please confirm these receivers simulate *bearing*, not just RSSI/frequency. I need 1 Hz synchronous timestamps for the MVP. Also send ground-truth `(timestamp_s, object_id, x_m, y_m)` only for evaluation, and a separate `observation_id → source_object_id` mapping for the generator's required answer key. I will return estimated positions, track status, RMSE, and a comparison plot.

---

## 4. Algorithm 1: convert RF bearings into 2D position

### 4.1 Physical interpretation

At a timestamp, RF1 located at `(x1,y1)` measures a line of arrival toward a drone. RF2 measures another. In 2D, their **forward rays** intersect near the drone. Actual measured bearings have noise, so the estimated intersection differs from the hidden true coordinate.

**One-drone assumption:** both simultaneous signals are from the same transmitter/drone, so measurement-to-track association is trivial. Do not introduce matching logic yet.

### 4.2 Formulas

For a clockwise-from-North bearing `b` (in radians), the world-space **unit direction** is

```
u(b) = [sin(b), cos(b)]
```

A receiver at `s` defines the forward ray

```
p = s + t * u(b),  t >= 0
```

For receivers `s1, s2` with unit vectors `u1,u2`:

```
s1 + t1*u1 = s2 + t2*u2

d = s2 - s1
cross(a,b) = a_x*b_y - a_y*b_x

D  = cross(u1,u2)
t1 = cross(d,u2) / D
t2 = cross(d,u1) / D
p  = s1 + t1*u1
```

Handle degeneracies:

- If `abs(D) < 0.15` (approximately near-parallel or antiparallel rays), return `invalid_geometry`; their intersection is extremely sensitive to noise.
- If `t1 < 0` or `t2 < 0`, intersection lies **behind** a receiver: return `invalid_ray_direction`.
- Optionally reject if ray distance exceeds `max_range_m` (e.g. 20 km) or coordinates are non-finite.
- Do not silently fall back to truth if no intersection is possible.

**Sanity-check test:**

- RF1 `(0,0)` bearing `45°`.
- RF2 `(6000,0)` bearing `315°`.
- Expected intersection **`(3000,3000)` metres**.  
  Check: RF1 sees northeast; RF2 sees northwest.

### 4.3 Optional global bearing conversion

If the sensor model reports bearings relative to its own antenna yaw:

```
bearing_global_deg = (bearing_local_deg + sensor_yaw_deg) % 360
```

But choose **one** convention at the team interface; do not apply yaw correction twice.

### 4.4 Synchronization

Preferred MVP: exactly one observation from each receiver at integer timestamps `0,1,2,…,29` seconds. For later asynchronous inputs, pair only measurements whose timestamps differ by at most `0.1 s` and document which time is used (e.g. mean timestamp). Never pair arbitrarily distant timestamps because the drone can move between them. If one receiver is absent, no triangulated measurement exists for that time.

---

## 5. Algorithm 2: track a time series with a Kalman filter

A spline is **not required** and should not be your first implementation. Store the trajectory as timestamped points and smooth/predict using a 2D constant-velocity Kalman filter.

### 5.1 State and measurement model

State vector (four scalars):

```
x = [px, py, vx, vy]^T
```

For elapsed time `dt` seconds:

```
F = [[1,0,dt,0 ],
     [0,1,0, dt],
     [0,0,1, 0 ],
     [0,0,0, 1 ]]

H = [[1,0,0,0],
     [0,1,0,0]]

z = [triangulated_x, triangulated_y]^T
```

Use standard predict and update:

```
x_pred = F @ x
P_pred = F @ P @ F.T + Q

innovation = z - H @ x_pred
S = H @ P_pred @ H.T + R
K = P_pred @ H.T @ inverse(S)
x_updated = x_pred + K @ innovation
P_updated = (I - K @ H) @ P_pred
```

Use `np.linalg.solve` where convenient for numerical stability, and preferably the Joseph form of the covariance update `(I-KH) P (I-KH)^T + K R K^T`.

**Working starting parameters (tunable, not challenge requirements):**

- Initial position = first valid triangulation; initial velocities `(0,0)` m/s.
- Initial covariance `diag(100^2, 100^2, 30^2, 30^2)`.
- `R = diag(60^2, 60^2)` m² for triangulated position uncertainty; refine later based on angle geometry/distance.
- `Q` = constant-acceleration process-noise covariance with `sigma_a=2.0 m/s²`, or use a small positive diagonal if time is extremely constrained.
- Skip measurement update when rays are invalid or one sensor drops out; **predict only** from the last track state, and label it `prediction_only`.

### 5.2 Initialization, dropout and time handling

1. Iterate across the requested scenario clock: `t = 0,1,…,duration-1` at `sample_period_s`.
2. Before first valid triangulation, you have **no track**; emit nothing (or an explicit `uninitialized` record, but not a guessed position).
3. At first valid triangulation, initialize `x` and `P`.
4. At each subsequent tick, **predict** with `dt` since the previous tick.
5. If a valid paired bearing intersection exists, apply measurement **update**.
6. Otherwise, keep prediction; mark `prediction_only`, ideally with growing position covariance.
7. If a long outage makes the track unreliable, optionally mark `stale`; not necessary for the first milestone.

### 5.3 Output schema

`estimated_track.json`:

```json
{
  "scenario_id": "ukraine_demo_001",
  "track_id": "track_1",
  "method": "two_ray_triangulation+constant_velocity_kalman",
  "points": [
    {
      "timestamp_s": 0.0,
      "x_m": 3000.0,
      "y_m": 3000.0,
      "vx_mps": 0.0,
      "vy_mps": 0.0,
      "status": "measurement_update",
      "observation_ids_used": ["obs_0001", "obs_0002"]
    }
  ]
}
```

Coordinates here are **estimated**, and must not be populated from `ground_truth`.

---

## 6. Algorithm 3: evaluate versus hidden truth

Evaluation runs **after** estimation. Compare each estimated `(x,y)` to ground-truth `(x,y)` at the **same timestamp**:

```
error_t = sqrt((x_est - x_true)^2 + (y_est - y_true)^2)
RMSE_m = sqrt(mean(error_t^2))
MAE_m  = mean(error_t)
```

Compute at least:

- `rmse_m` over all valid predicted/updated track points that have truth at that time.
- `mean_error_m` and optionally `max_error_m`.
- `total_frames`, `frames_with_two_readings`, `successful_triangulations`, `measurement_update_frames`, `prediction_only_frames`.
- Optional separate RMSE for measurement-updated versus prediction-only frames.

`metrics.json` example layout (numeric results are intentionally blank until run):

```json
{
  "scenario_id": "ukraine_demo_001",
  "rmse_m": null,
  "mean_error_m": null,
  "max_error_m": null,
  "total_frames": 30,
  "successful_triangulations": null,
  "measurement_update_frames": null,
  "prediction_only_frames": null
}
```

**Do not claim an accuracy number that the code has not actually measured.** For empty comparisons return `null` plus an explanation rather than fake zero error.

### Required plot

`trajectory_comparison.png` (X = east, Y = north) must show:

1. `RF1`, `RF2` receiver points (different marker shapes).
2. True drone trajectory as a line (from ground truth, visualization/evaluation layer only).
3. Raw triangulated points as dots (optional faint style).
4. Kalman estimated trajectory as another line.
5. Equal axis aspect ratio, a legend, metre units; visibly indicate dropout interval if easy.

This is the **best 30-second demonstration** for a judging milestone: intentionally drop one receiver for a few seconds and show the estimated track continuing, with uncertainty rising and later correcting when RF2 returns.

---

## 7. Self-contained fixture: unblock yourself without teammates

A ready-made `scenario_2d_fixture.json` accompanies this brief. It contains:

- A central-Ukraine-labelled illustrative **local** coordinate frame. (The fixture is **not yet terrain simulation**; your team's generator must eventually supply real Ukrainian terrain to satisfy the overall hackathon.)
- Two receivers at `(0,0)` and `(6000,0)` metres.
- One drone starting at `(3000,3000)` and moving linearly at `vx=20`, `vy=12` m/s for 30 s.
- One-Hz RF readings with `~1°` Gaussian bearing noise and approximate free-space RF power for visualization/testing; random seed fixed.
- A deliberate RF2 dropout at timestamps `10–14 s`; ground truth remains continuous throughout.
- Ground truth and observation-to-object associations kept as logically distinct fields.

The fixture is a **test double**, not a substitute for your team's source generator. After it works, switch the input path to the team's export using the same schema.

---

## 8. Repository skeleton and public functions

Ask Codex to use/adapt this lightweight structure inside your team's repository:

```text
rf_fusion/
  __init__.py
  geometry.py            # bearing unit vectors; ray intersection
  tracking.py            # constant-velocity Kalman filter
  pipeline.py            # pair observations; estimate one track
  evaluation.py          # truth comparison, RMSE, coverage
  visualization.py       # overlay true, raw, filtered trajectories
  cli.py                 # python -m rf_fusion.cli ...
tests/
  test_geometry.py
  test_pipeline.py
  test_tracking.py
examples/
  scenario_2d_fixture.json
requirements.txt
README_RF_FUSION.md
outputs/                     # generated, gitignore as appropriate
```

Suggested Python API:

```python
def bearing_to_unit(bearing_deg: float) -> tuple[float, float]: ...

def triangulate_two_bearings(
    sensor1_xy: tuple[float, float], bearing1_deg: float,
    sensor2_xy: tuple[float, float], bearing2_deg: float,
    min_sin_angle: float = 0.15,
    max_range_m: float | None = 20000.0,
) -> tuple[float, float] | None: ...

def estimate_track(sensors: list[dict], observations: list[dict],
                   duration_s: float, sample_period_s: float) -> dict: ...

def evaluate_track(estimated_track: dict, ground_truth: list[dict]) -> dict: ...
```

A separate failure-reason return type for triangulation is welcome **only if quick**; use `None` for invalid geometry in the MVP.

**Dependencies:** `numpy`, `matplotlib`, `pytest`. Do not introduce SciPy, pandas, GIS tooling, Blender, `pytak`, ML frameworks, databases, or web services for the two-hour scope.

### The exact CLI to support

```bash
python -m venv .venv
source .venv/bin/activate             # Linux / WSL / macOS
# Windows PowerShell: .venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt

python -m rf_fusion.cli \
  --scenario examples/scenario_2d_fixture.json \
  --output outputs/demo

python -m pytest -q
```

The CLI should print: number of triangulations, number of prediction-only frames, RMSE (when truth supplied), and output paths. It should write three artifacts:

```text
outputs/demo/estimated_track.json
outputs/demo/metrics.json
outputs/demo/trajectory_comparison.png
```

---

## 9. Minimum tests to implement, in priority order

| Test | Input and expected result |
|---|---|
| **World bearing convention** | `0°→(0,+1)`, `90°→(+1,0)`, `180°→(0,-1)`, `270°→(-1,0)`. |
| **Perfect geometry** | RF1 `(0,0)` / 45°, RF2 `(6000,0)` / 315° gives `(3000,3000)` to tolerance `<1e-6 m`. |
| **Degenerate geometry** | Parallel/antiparallel bearings produce `None`, not infinities/NaN. |
| **Backward ray** | Crossing behind either receiver is rejected. |
| **Missing reading** | One receiver silent → predict-only if a tracker exists; no fake measurement. |
| **No ground-truth leakage** | Change truth data, rerun estimator: predicted track should remain identical; only evaluation metrics change. |
| **End-to-end fixture** | CLI executes, writes well-formed JSON + a nonempty PNG, and reports a finite RMSE. |
| **Seed reproducibility** | Re-running against the same JSON produces the same track and metrics. |

Optional if time: a noisy bearing test using seeded random data and a generous sanity threshold; an asynchronous observation case; sensor orientation conversion.

---

## 10. Integration choices and common mistakes

1. **Bearing vs signal strength:** RF frequency identifies bands/links, power can hint at range/attenuation, but the **triangulation** in this milestone uses **azimuth**, not frequency or RSSI.
2. **Bearing sensor assumption:** AoA requires an appropriate directional/array/specialized sensor model; do not present ordinary receivers as magically measuring direction.
3. **One drone only:** no association algorithm, no risk of pairing two different drone emitters. Assumption must be documented.
4. **Timestamps:** all readings and truth use the same scenario clock. Do not join one sensor at t=5 s with another at t=7 s.
5. **Units:** radians inside `sin/cos`; degrees at the JSON boundary. X east, Y north. Never feed latitude/longitude degree values directly to a metre-based triangulator.
6. **Geometry:** very shallow crossing angles create huge localization error even with slight bearing noise; reject untrustworthy geometry.
7. **Ground truth separation:** the estimator must not use true drone position to initialize velocity or track through dropout. It can only initialize on a valid triangulation.
8. **Missing detection:** no return from RF2 ≠ bearing 0°; Kalman prediction continues until it returns.
9. **Physical realism:** the team's simulator owns antenna physics, terrain attenuation, receiver range, and signal dropout; your estimation module must deal gracefully with the imperfect reports. Ideal 2D geometry is *development stage*, not the final full-hackathon claim.
10. **TAK:** CoT/TAK is an optional exchange/visualization format. JSON is fine for internal records because the brief permits invented formats.
11. **Single receiver:** one bearing yields a ray, not a 2D point; you cannot estimate a unique new position from a single bearing without relying on a motion prior or more information.
12. **Filtering:** the Kalman output is a *sequence of states*, not a spline. If a frontend later wants a smooth rendered curve, interpolate the states there.

---

## 11. What to demonstrate at the milestone

**30-second demo script:**

1. Show two RF receiver positions 6 km apart and a synthetic one-drone flight.
2. Explain: “At each second, two imperfect azimuth bearings intersect to give a raw 2D position estimate.”
3. Show the estimated trajectory against the simulator's true trajectory and report the **measured** RMSE.
4. Point out the brief RF2 loss at 10–14 s: “When a receiver stops reporting, we predict from motion and explicitly label it as a prediction. When observations return, the track corrects.”
5. Explain the value: “This validates that synthetic observations are causally tied to one hidden world, instead of arbitrary numbers made up independently.”

**What to hand your lead:**

```text
DONE: 2D bearing-based RF localization + constant-velocity Kalman tracking.
INPUT: JSON with two receiver locations and 1-Hz global RF bearings.
OUTPUT: estimated_track.json, metrics.json, trajectory_comparison.png.
DEMO: python -m rf_fusion.cli --scenario examples/scenario_2d_fixture.json --output outputs/demo
LIMITATIONS: one drone, two azimuth-capable receivers, 2D; no terrain/rain modeled in this module.
NEXT: plug in real-terrain-aware RF output from simulation team; later add height/elevation angles.
```

---

## 12. How to spend extra minutes, and what to drop if late

### If ahead of schedule

- Add uncertainty ellipse or just position covariance to outputs.
- Use crossing-angle-dependent observation uncertainty `R` rather than fixed `60² m²`.
- Visually annotate RF2 outage in the plot.
- Export track as optional CoT/TAK events **only after** the demo and tests work.

### If behind schedule

1. Keep **triangulation and JSON export** no matter what.
2. Add simple tracking with prediction-only; do not chase a perfect Kalman tune.
3. Save the static Matplotlib plot and a single RMSE.
4. Drop support for asynchronous timestamps, yaw transforms (if the contract uses global azimuth), uncertainty ellipse, custom exceptions, and TAK.
5. Do **not** take on 3D, terrain processing, sensor camera simulation, or a web app.

---

## 13. Ready-to-run Codex instruction

Copy this into Codex after placing this brief and `scenario_2d_fixture.json` in the repository (or use the separate `CODEX_Start_RF_Fusion.md`):

> Implement the attached `Mirror_World_RF_Fusion_2_Hour_Implementation_Brief.md` now. I own only the RF localization/tracking/evaluation subsystem of a hackathon project, not the world generator. Follow the specified single-file JSON contract and CLI. Inspect existing repository structure first, integrate without overwriting colleagues' work, and work in five stages: bearing geometry + tests, Kalman filter + tests, JSON pipeline, plotting/evaluation, CLI/README and full test run. The estimator must consume only sensor poses, bearing observations, and time metadata, never ground truth or observation-to-object associations. Use NumPy/Matplotlib/Pytest only, local ENU metres, bearings clockwise from North, 1 drone, 2 AoA RF sensors, 1-Hz sampling, 2D only. In invalid geometry/dropouts, report missing measurements and predict from the Kalman filter. Produce `estimated_track.json`, `metrics.json`, `trajectory_comparison.png`. Run the exact CLI and pytest, fix failures, and summarize what is genuinely working and what remains. Do not implement 3D, terrain, camera, TAK, a SaaS, or multi-object association. Prefer a working end-to-end result over more features.

---

## Source basis and scope note

Prepared from **“Mirror World: a synthetic defence scenario generator,” Jakub Cerny, 16 October 2026**, especially page 1 (“The challenge,” “What you hand in,” “Which sensors,” and “A realistic setup”) and page 2 (sample RF trace, bearings, and example TAK event). The *generator* requirements above follow the brief. The **2-hour localization/filtering workflow and numerical implementation decisions are our engineering recommendation**, not mandatory items in the brief.
