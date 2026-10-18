import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { generateRfScenario } from "../src/sensor-generator.ts";

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
  const generated = generateRfScenario(trajectory, config);
  mkdirSync(values.output, { recursive: true });
  for (const [name, value] of Object.entries({ "scenario.json": generated.scenario, "sensor_report.json": generated.report, "bearing_fixes.json": generated.fixes, "rf_diagnostics.json": generated.rfFrames })) {
    writeFileSync(resolve(values.output, name), JSON.stringify(value, null, 2) + "\n");
  }
  console.log(JSON.stringify(generated.report, null, 2));
  console.log(`Wrote scenario.json, sensor_report.json, bearing_fixes.json, rf_diagnostics.json to ${values.output}`);
} catch (error) {
  console.error(`RF generation failed: ${error.message}`);
  process.exitCode = 1;
}
