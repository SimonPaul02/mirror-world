import { mkdir, rename, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenario } from "./engine/config.mjs";
import { readTerrain } from "./engine/terrain.mjs";
import { generateTrajectory } from "./engine/trajectory.mjs";

// node terrain/generate.mjs [input.json] [output.json]
const defaultOutput = fileURLToPath(new URL("./generated/trajectory_truth.json", import.meta.url));
let temporaryPath;
try {
  if (process.argv.length > 4) throw new Error("Usage: node terrain/generate.mjs [input.json] [output.json]");
  const scenario = await loadScenario(process.argv[2]);
  const terrain = await readTerrain(scenario.elevationBytes, scenario.manifest);
  const outputPath = path.resolve(process.argv[3] ?? defaultOutput);
  const protectedPaths = [scenario.inputPath, scenario.manifestPath,
    ...Object.values(scenario.manifest.assets).map((asset) => path.resolve(path.dirname(scenario.manifestPath), asset.path))];
  if (protectedPaths.includes(outputPath)) throw new Error("Output path overlaps an input or terrain asset");
  const result = generateTrajectory(scenario.input, terrain, scenario.manifest);
  await mkdir(path.dirname(outputPath), { recursive: true });
  temporaryPath = `${outputPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  await rename(temporaryPath, outputPath);
  temporaryPath = undefined;
  console.log(JSON.stringify({ status: "pass", output: outputPath, states: result.trajectory_truth.length,
    minimum_surface_clearance_m: result.validation.minimum_surface_clearance_m,
    validated_through_elapsed_s: result.validation.validated_through_elapsed_s }, null, 2));
} catch (error) {
  if (temporaryPath) await rm(temporaryPath, { force: true });
  console.error(JSON.stringify({ status: "failed", code: error.code ?? "INVALID_INPUT",
    message: error.message, details: error.details ?? {}, output_written: false,
    note: "Any existing output from an earlier run is unchanged." }, null, 2));
  process.exitCode = 1;
}
