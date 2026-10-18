# Sam's hackathon TODOs — RF scenario data

Working agreement: keep this checklist current and automatically commit completed, verified changes as we work together.

Latest verification: app production build passed; four Python tests passed; the fixture CLI produced its track JSON, metrics JSON, and comparison PNG (43.9 m RMSE, five prediction-only frames). A synthetic capture contract check passed with 60 truth frames, 120 RF observations, and 120 associations. A live browser capture with real terrain is still pending.

## What the challenge requires

Build a **configurable synthetic scenario generator** set on **real terrain in Ukraine**. For each scenario, output:

1. Ground truth: where the drone, receivers, and other objects actually were over time.
2. Time-synchronized sensor records, including a radio signal trace.
3. An answer key linking **each sensor record** to the object that caused it.

The sensor data should plausibly follow the same underlying scenario: position changes the bearing and signal strength; terrain can attenuate or block reception. The brief values creativity and functionality, and does not demand tactical precision.

**Crossing RF bearings and estimating a trajectory are not mandatory challenge outputs.** They are a useful validation and demonstration: if the generated measurements reconstruct a plausible track near truth, the data is more convincing. Two receivers are an example in the brief, not a requirement.

## Team ownership

- **Arda:** drone model and trajectory; supplies the drone's timestamped true positions and altitude.
- **Sam:** receiver placement/configuration, RF sensor modeling, synthetic measurements, observation associations, and localization/tracking validation. Sam combines drone truth and receiver truth in the final scenario export.
- **Simone:** terrain selection and terrain data; helps Sam check receiver placement against the selected terrain.
- **Ygit:** UI and interfaces.

Arda's export contains the drone trajectory only. Sam generates the sensors and their readings.

## My priorities and current status

- [x] **Draft the shared data contract.** The `Scenario .json` download contains ENU receiver positions, a common sample clock, drone truth, RF observations, and associations. `README_RF_FUSION.md` documents it.
- [ ] **Confirm the contract with teammates.** Arda supplies the timestamped trajectory and altitude; Simone confirms the terrain area/provider; Sam chooses/configures receiver sites; Ygit confirms the export/UI handoff. These people have not yet confirmed the contract.
- [ ] **Import Arda's trajectory export.** Accept the `drone_trajectory.json` contract below and feed its sampled positions to the RF generator. The current browser capture uses this repo's own live flight simulation; importing Arda's file is still pending.
- [x] **Connect the existing RF model to scenario capture.** `src/signals.ts` generates per-receiver power, noisy global bearings, and missed detections from the flown truth. The capture records these with a fixed seed. Each report now records how much of its RF path had terrain samples.
- [x] **Implement a configurable scenario export.** URL parameters select seed, route variant (`full`, `south`, or seeded waypoint variation), duration, and sample interval. The download includes configuration, truth, observations, misses, and a separate observation-to-object answer key. A presentation run must cover at least a few minutes; the 30-second fixture is only a development test.
- [x] **Add structural validation.** Export warnings check duration, real-terrain provider availability, terrain path sample coverage, timestamps, bearings, IDs, and associations.
- [ ] **Verify a live terrain-backed capture.** Run the browser with loaded real Ukrainian terrain for at least two minutes, export JSON, inspect the warnings and signal behavior, and fix any terrain coverage gaps. This has not yet been run in this workspace.
- [ ] **Exercise Ard's route variants.** Verify at least a straight and a curved route once Ard supplies them. Current app choices are the existing full Donbas circuit and a shorter southern circuit.
- [x] **Demonstrate independent 2D localization.** `rf_fusion` intersects simultaneous forward AoA rays and rejects weak geometry; it does not read truth or associations.
- [x] **Demonstrate trajectory estimation.** A constant-velocity Kalman filter predicts through RF dropouts. The CLI exports JSON metrics and a comparison PNG. The 30-second fixture produced 25 intersections, five prediction-only frames, and 43.9 m RMSE; four tests passed.
- [ ] **Hand Ygit a live exported scenario and its measured estimate.** The UI currently shows its own instantaneous crossed-bearing fixes; the independent filtered track is a downloadable report, not yet drawn in Cesium.

## MVP assumptions

- One drone, two stationary AoA-capable RF receivers, no weather. These are implementation choices, not challenge rules.
- Start with a simple route. More complex curves or splines are optional scenario variants, owned by Ard.
- Use 2D local coordinates in metres for bearing intersection (`x` East, `y` North; bearing clockwise from North). Drone altitude and actual terrain still matter to the RF simulation. Cesium's viewing mode is a UI choice.
- Synchronize all outputs to one scenario clock. Current app reporting is every 2 seconds; the handoff fixture uses 1 second. Choose one shared interval at integration.

## Arda → Sam: proposed trajectory export

Export **`drone_trajectory.json`** containing the drone's actual sampled positions as it follows the spline. Sam needs the evaluated positions over time; spline coefficients and a 3D model are not needed for RF generation. If the flown path differs from the planned spline, export the flown positions.

Use WGS84 latitude/longitude in degrees and `hae_m` in metres **above the WGS84 ellipsoid**, matching Cesium `Cartographic.height`. Do not pass height above ground as `hae_m`. `agl_m` is optional extra metadata. Sam converts the coordinates to the common local east/north frame.

Suggested sampling is **1 Hz in simulation time** for 180 seconds (`timestamp_s = 0, 1, …, 179`). A different explicit sample period is acceptable; timestamps must increase and share the scenario clock. Export clean truth with no sensor noise.

Example (shortened to two samples):

```json
{
  "scenario_id": "ukraine_demo_001",
  "start_utc": "2026-11-03T12:10:00Z",
  "coordinate_frame": "wgs84",
  "height_reference": "ellipsoid",
  "duration_s": 180,
  "sample_period_s": 1,
  "ground_truth": [
    {"timestamp_s": 0, "object_id": "D1", "lat": 48.72, "lon": 37.85, "hae_m": 1000},
    {"timestamp_s": 1, "object_id": "D1", "lat": 48.7201, "lon": 37.8502, "hae_m": 1000}
  ]
}
```

For a live connection, the same sample fields can be passed directly each tick instead of writing a file. Receiver placement, RF measurements, and observation associations are Sam's outputs. The radio frequency/power model can use shared emitter defaults; Arda does not need to simulate RF.

## Existing starting point

- `src/signals.ts` already simulates RF detections, terrain loss, noisy bearings, and crossed-bearing fixes.
- `src/scenario.ts` defines the Donbas route and receiver defaults. `src/main.ts` now accepts query parameters and exports the captured scenario through `src/scenario-data.ts`.
- `examples/scenario_2d_fixture.json` is a 30-second local-coordinate test fixture, not proof of real-terrain scenario generation.

## RF model choice and sources

The challenge requires a radio signal trace that is faithful to the scenario; it does not mandate a particular RF library, propagation standard, or trained AI model. Some mathematical sensor simulation is needed to generate those records.

For this MVP, keep the lightweight model already in `src/signals.ts`:

- Distance/frequency attenuation using free-space path loss; reference: [ITU-R P.525](https://www.itu.int/rec/R-REC-P.525/en).
- Approximate terrain attenuation using the single knife-edge diffraction formula applied to the worst sampled obstruction; reference: [ITU-R P.526](https://www.itu.int/rec/R-REC-P.526/en). This is a simplified approximation, not a complete implementation of the recommendation.
- Configured transmitter frequency/power and receiver gain/noise floor, plus heuristic fading, bearing error, and a detection threshold. The bearing/noise parameters are simulation assumptions, not calibrated hardware measurements.

An existing external propagation library is [NTIA's Irregular Terrain Model](https://github.com/NTIA/itm). It predicts terrestrial path loss from terrain and radio parameters; it would still need our bearing/detection model and an assessment of its suitability for the drone's flight conditions. It is an alternative, not a dependency of the current MVP.

- [ ] Validate the RF model with a clear path versus an obstructing ridge, a distance-loss sanity check, and the selected real terrain before presenting its outputs as a demonstrated terrain-aware generator.
