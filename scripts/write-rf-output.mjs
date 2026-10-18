import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export function writeRfOutput(directory, generated) {
  mkdirSync(directory, { recursive: true });
  for (const [name, value] of Object.entries({ "scenario.json": generated.scenario, "sensor_report.json": generated.report, "bearing_fixes.json": generated.fixes, "rf_diagnostics.json": generated.rfFrames, "cot_answer_key.json": generated.cotAssociations })) {
    writeFileSync(resolve(directory, name), JSON.stringify(value, null, 2) + "\n");
  }
  writeFileSync(resolve(directory, "sensor_trace.cot"), generated.cot);
}
