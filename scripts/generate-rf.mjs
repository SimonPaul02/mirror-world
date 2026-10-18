import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { generateRfScenario } from "../src/sensor-generator.ts";
import { loadRfTerrain } from "./load-rf-terrain.mjs";
import { writeRfOutput } from "./write-rf-output.mjs";

try {
  const { values } = parseArgs({ options: {
    trajectory: { type: "string", default: "examples/drone_trajectory_mock_60s.json" },
    config: { type: "string", default: "examples/rf_sensor_config.json" },
    terrain: { type: "string" },
    output: { type: "string", default: "outputs/mock_60s" },
  } });
  const trajectory = JSON.parse(readFileSync(resolve(values.trajectory), "utf8"));
  const config = JSON.parse(readFileSync(resolve(values.config), "utf8"));
  if (values.terrain) config.terrain = JSON.parse(readFileSync(resolve(values.terrain), "utf8"));
  const terrain = config.terrain.kind === "manifest" ? await loadRfTerrain(config.terrain.manifest_path) : undefined;
  const generated = generateRfScenario(trajectory, config, terrain?.verified);
  writeRfOutput(values.output, generated);
  console.log(JSON.stringify(generated.report, null, 2));
  console.log(`Wrote scenario, sensor report, bearing fixes, diagnostics, TAK trace, and answer keys to ${values.output}`);
} catch (error) {
  console.error(`RF generation failed: ${error.message}`);
  process.exitCode = 1;
}
