# Sam's hackathon TODOs — RF scenario data

Working agreement: keep this checklist current and automatically commit completed, verified changes as we work together.

Latest real-input result: `npm run demo:odesa-rf` uses the merged team's 300-second Odesa trajectory, original DSM, and matching geoid. It generates 600 RF detections and 300 fixes with no missing terrain samples. Receiver baseline is 8.9 km; observed crossing angles are about 41–87 degrees. Raw RMSE is 628.0 m and filtered RMSE is 292.9 m under the configured simulated RF errors. The default 1,500 m flight clears this terrain, so no terrain dropouts are invented. These figures describe simulated errors, not hardware calibration.

The one-minute mock remains as a separate controlled ridge/dropout demo. The main Odesa viewer supports 2D/3D navigation, 1–5 drones, 0–12 RF sites, 0–5 fixed/onboard cameras, and 0–3 satellite context sources. Configurations and synchronized records export in a complete scenario bundle. Verification: 39 automated tests pass, the production build passes, and mixed-sensor/multi-drone browser workflows pass with no page errors.

## Manual scenario controls (confirmed scope)

Sam chooses the sensor mix and counts; automatic sensor-set optimization is outside this task.

- [x] 2D/3D toggle, pan/zoom pad and north reset.
- [x] Configurable RF count including zero/one; manual placement is the default, with coordinate editing and click-to-place for every RF receiver and fixed camera. Random placement is an explicit option and button, within the original terrain crop; changing counts alone never randomizes sites. More than two RF sites use the best valid measured pair at each timestamp, not all-receiver least-squares fusion.
- [x] Multiple drones with individual IDs, starts and headings, terrain validation, common clock, separate RF channels/results, an inspect selector, and accumulating estimate trails.
- [x] Camera count and fixed/drone mount selection; editable/randomized ground sites, orientation and host selection; geometric observations, answer keys and timestamped schematic previews.
- [x] Satellite count selection and static terrain-context records/assets with footprint, dimensions, source grid spacing and attribution. These are DSM hillshade context, not optical acquisitions or target detections.
- [x] Complete bundle download; selected-drone RF JSON/TAK remain compatible with the existing estimator. RF IDs are scoped by each child scenario ID. Configuration changes invalidate stale sensor exports.
- [ ] Photorealistic camera images with blur/noise; actual optical satellite imagery or synthetic drone insertion. The current controls and records explicitly identify their simplified models.

## What the challenge requires

Build a **configurable synthetic scenario generator** set on **real terrain in Ukraine**. For each scenario, output:

1. Ground truth: where the drone, receivers, and other objects actually were over time.
2. Time-synchronized sensor records, including a radio signal trace.
3. An answer key linking **each sensor record** to the object that caused it.

The sensor data should plausibly follow the same underlying scenario: position changes the bearing and signal strength; terrain can attenuate or block reception. The brief values creativity and functionality, and does not demand tactical precision.

**Crossing RF bearings and estimating a trajectory are not mandatory challenge outputs.** They are a useful validation and demonstration: if the generated measurements reconstruct a plausible track near truth, the data is more convincing. Two receivers are an example in the brief, not a requirement.

## Confirmed sensor roadmap

Sam confirmed the three types are **RF, camera, and satellite**, not three RF receivers. The baseline uses two fixed directional arrays, while the controls now support 0–12. Sam owns receiver placement and sensor simulation; the trajectory producer supplies drone truth, Simone supplies terrain, and Ygit owns the interface.

- [x] RF records, bearing crossing, and trajectory validation against the merged team output.
- [x] Camera MVP: timestamped schematic pinhole views from fixed/drone-mounted sites, with associations and explicit field of view/resolution/LOS assumptions. Photorealistic rendering remains pending.
- [x] Satellite context MVP: timestamped DSM hillshade context with footprint and source spacing, separate from optical acquisitions and drone detections. Optical imagery remains pending. These image types are bonuses in the challenge PDF.

## My priorities and current status

- [x] **Draft the shared data contract.** The `Scenario .json` download contains ENU receiver positions, a common sample clock, drone truth, RF observations, and associations. `README_RF_FUSION.md` documents it.
- [x] **Verify the producer contract on actual merged output.** The team's `toReceiverGroundTruth` export feeds our importer with matching IDs/cadence and correct ellipsoidal altitude. Preserve the producer's UTC start explicitly. Sam configures receivers against Simone's terrain.
- [x] **Implement Arda's trajectory importer.** `src/trajectory.ts` validates sampled WGS84 positions/ellipsoidal heights. The headless Odesa runner and main replay now feed the merged team's actual positions to the RF generator. The one-minute curved-flight mock remains available for isolated tests.
- [x] **Configure mock receiver placement and RF settings.** `examples/rf_sensor_config.json` defines two arrays 3 km apart, transmitter frequency/power, receiver heights/gains/noise, and a synthetic ridge. The observed fixes have crossing angles of about 45–68 degrees. Actual terrain/site selection remains to be finalized with Simone; Sam owns the sensors.
- [x] **Connect the existing RF model to scenario capture.** `src/signals.ts` generates per-receiver power, noisy global bearings, and missed detections from the flown truth. The capture records these with a fixed seed. Each report now records how much of its RF path had terrain samples.
- [x] **Implement a configurable scenario export.** URL parameters select seed, route variant (`full`, `south`, or seeded waypoint variation), duration, and sample interval. The download includes configuration, truth, observations, misses, and a separate observation-to-object answer key. A presentation run must cover at least a few minutes; the 30-second fixture is only a development test.
- [x] **Add structural validation.** Export warnings check duration, real-terrain provider availability, terrain path sample coverage, timestamps, bearings, IDs, and associations.
- [x] **Integrate the pulled Odesa package.** Verify asset hashes, sample the original DSM and geoid in the same vertical frame as the drone, avoid adding blanket clutter to a DSM, and export a real-terrain five-minute RF scenario.
- [x] **Position receivers and expose controls.** `examples/rf_sensor_odesa.json` configures two sites west of the route. The main replay draws sites/bearings/fixes and allows coordinate edits plus regeneration for the same flight. Changing trajectory settings invalidates the old RF capture.
- [x] **Accumulate an error-colored RF estimate trail.** The Odesa replay reveals dots and segments at each timestamp, with green ≤100 m, yellow at 500 m, and red ≥1,000 m horizontal error against truth. Current fix and uncertainty use the same color. Show current error and cumulative RMSE; hide future points when rewinding/restarting, preserve missing-fix gaps, and clear/rebuild when settings change. These are instantaneous RF fixes; the independently filtered track remains in CLI outputs.
- [x] **Verify the live browser workflow.** Generated the real flight, scrubbed to its matching RF timestamp, applied a changed receiver coordinate, rejected an out-of-terrain site, checked downloaded JSON and all 902 CoT events, and verified trajectory edits invalidate old RF downloads. No browser page errors.
- [x] **Export the signal trace as TAK XML.** Per-receiver detections and aggregate fixes use the real scenario clock. JSON and CoT answer keys identify record sources; unknown terrain generates no fabricated observations.
- [ ] **Exercise Ard's route variants.** Verify at least a straight and a curved route once Ard supplies them. The merged Odesa generator currently supplies seeded smooth turns; the older Donbas viewer has full and southern circuits.
- [x] **Demonstrate independent 2D localization.** `rf_fusion` intersects simultaneous forward AoA rays and rejects weak geometry; it does not read truth or associations.
- [x] **Demonstrate trajectory estimation.** A constant-velocity Kalman filter predicts through RF dropouts, weights fixes using bearing uncertainty and crossing geometry, and gates inconsistent measurements. The one-minute mock produces track/metrics JSON, a trajectory comparison PNG, and an RF power/terrain-loss PNG. Its 35-second outage is terrain-driven; the measured whole-track RMSE is 73.6 m.
- [x] **Prepare Ygit's integration handoff.** `outputs/odesa/` contains the reproducible RF scenario, TAK trace, answer keys, diagnostics, estimates, metrics, validation report, and two plots. The main viewer now shows the same flight's instantaneous RF fixes; the independent filtered track remains in the CLI report. No external message has been sent.

## MVP assumptions

- Baseline: one drone, two stationary AoA-capable RF receivers, no weather. Controls now allow 1–5 drones and 0–12 RF receivers, plus optional cameras/context sources. Multi-drone RF simulation assumes ideal separation by configured transmitter frequency; RF identity association/interference is not modeled.
- Start with a simple route. More complex curves or splines are optional scenario variants, owned by Ard.
- Use 2D local coordinates in metres for bearing intersection (`x` East, `y` North; bearing clockwise from North). Drone altitude and actual terrain still matter to the RF simulation. Cesium's viewing mode is a UI choice.
- Synchronize all outputs to one scenario clock. The integrated Odesa run uses 1-second truth and RF samples. The older Donbas viewer defaults to 2-second reporting.

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

- [x] **Validate the RF model on controlled cases.** Doubling distance adds 6.0206 dB loss. With noise disabled, clear paths give 60 fixes and perfect bearing crossings have less than 0.001 m horizontal error over this short route. Adding the synthetic ridge reduces RF2 detections from 60 to 25 with up to 39.6 dB additional attenuation; RF1 is unaffected. Missing terrain does not generate valid detections. See `outputs/mock_60s/rf_validation.json` and `npm run test:sensors`.
- [x] **Validate the selected real terrain integration.** The original Odesa DSM/geoid, exact height conversion, coverage, timing, RF values, and output associations are checked. Signal physics is still an approximation; only comparison with actual hardware measurements could calibrate its realism.
