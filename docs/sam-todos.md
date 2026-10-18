# Sam's hackathon TODOs — RF scenario data

## What the challenge requires

Build a **configurable synthetic scenario generator** set on **real terrain in Ukraine**. For each scenario, output:

1. Ground truth: where the drone, receivers, and other objects actually were over time.
2. Time-synchronized sensor records, including a radio signal trace.
3. An answer key linking **each sensor record** to the object that caused it.

The sensor data should plausibly follow the same underlying scenario: position changes the bearing and signal strength; terrain can attenuate or block reception. The brief values creativity and functionality, and does not demand tactical precision.

**Crossing RF bearings and estimating a trajectory are not mandatory challenge outputs.** They are a useful validation and demonstration: if the generated measurements reconstruct a plausible track near truth, the data is more convincing. Two receivers are an example in the brief, not a requirement.

## My priorities, in order

- [ ] **Agree the shared input contract.** Ard provides a timestamped drone trajectory and altitude; Simone provides the real Ukrainian terrain area/elevation and receiver sites. Agree one scenario clock, coordinates, IDs, and sample period with Ygit for the export/UI.
- [ ] **Connect and verify the RF generator.** Use the existing `src/signals.ts` model to generate per-receiver frequency, power, global azimuth bearing, and detection/missed-detection status from the same drone truth. Verify signal strength and dropouts respond plausibly to range and terrain. Use a fixed random seed for repeatable runs.
- [ ] **Export a complete configurable scenario.** Include configuration, ground truth, timestamped RF observations, and `observation_id -> source_object_id` associations. Keep truth and sensor records distinct. The final generated scenario must run for at least a few minutes; the 30-second fixture is only a development test.
- [ ] **Validate the generated data.** Check timestamps, units, IDs, receiver placement, terrain use, bearing convention, missing observations, and answer-key completeness. Run at least a straight route and a curved route if time permits.
- [ ] **Demonstrate sensor-derived localization.** Intersect two simultaneous forward AoA rays; reject weak crossing geometry. Never use truth or the association answer key to calculate the position.
- [ ] **Demonstrate trajectory estimation.** Track the position estimates with a constant-velocity filter; predict across RF dropouts and label predictions. Compare against truth afterward with RMSE and a plot. Integrate the results into Ygit's UI only after the generator export works.

## MVP assumptions

- One drone, two stationary AoA-capable RF receivers, no weather. These are implementation choices, not challenge rules.
- Start with a simple route. More complex curves or splines are optional scenario variants, owned by Ard.
- Use 2D local coordinates in metres for bearing intersection (`x` East, `y` North; bearing clockwise from North). Drone altitude and actual terrain still matter to the RF simulation. Cesium's viewing mode is a UI choice.
- Synchronize all outputs to one scenario clock. Current app reporting is every 2 seconds; the handoff fixture uses 1 second. Choose one shared interval at integration.

## Existing starting point

- `src/signals.ts` already simulates RF detections, terrain loss, noisy bearings, and crossed-bearing fixes.
- `src/scenario.ts` currently defines a fixed Donbas scenario; configurability and a complete scenario export need verification/implementation.
- `docs/examples/scenario_2d_fixture.json` is a 30-second local-coordinate test fixture, not proof of real-terrain scenario generation.
