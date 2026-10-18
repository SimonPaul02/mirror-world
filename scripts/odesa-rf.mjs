import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { loadScenario } from "../terrain/engine/config.mjs";
import { generateTrajectory } from "../terrain/engine/trajectory.mjs";
import { toReceiverGroundTruth } from "../terrain/engine/receiver-adapter.mjs";
import { generateRfScenario } from "../src/sensor-generator.ts";
import { loadRfTerrain } from "./load-rf-terrain.mjs";
import { writeRfOutput } from "./write-rf-output.mjs";

try {
  const { values } = parseArgs({ options: {
    input: { type: "string" },
    config: { type: "string", default: "examples/rf_sensor_odesa.json" },
    output: { type: "string", default: "outputs/odesa" },
  } });
  const source = await loadScenario(values.input);
  const terrain = await loadRfTerrain(source.manifestPath);
  const fullTruth = generateTrajectory(source.input, terrain.surface, source.manifest);
  const trajectory = {
    ...toReceiverGroundTruth(fullTruth, { scenarioId: "odesa_rf_001", geoid: terrain.geoidGrid }),
    start_utc: source.input.simulation.start_time,
    duration_s: source.input.simulation.duration_s,
    coordinate_frame: "wgs84",
    height_reference: "ellipsoid",
  };
  const config = JSON.parse(readFileSync(resolve(values.config), "utf8"));
  const generated = generateRfScenario(trajectory, config, terrain.verified);
  writeRfOutput(values.output, generated);
  writeFileSync(resolve(values.output, "drone_trajectory.json"), JSON.stringify(trajectory, null, 2) + "\n");
  writeFileSync(resolve(values.output, "source_trajectory_truth.json"), JSON.stringify(fullTruth, null, 2) + "\n");
  console.log(JSON.stringify(generated.report, null, 2));
} catch (error) {
  console.error(`Odesa RF generation failed: ${error.message}`);
  process.exitCode = 1;
}
