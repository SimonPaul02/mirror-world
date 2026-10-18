import { mkdir, copyFile, writeFile } from "node:fs/promises";
import { loadScenario } from "../terrain/engine/config.mjs";
import { readTerrain } from "../terrain/engine/terrain.mjs";
import { generateTrajectory } from "../terrain/engine/trajectory.mjs";
const destination = new URL("../public/trajectory/", import.meta.url);
const scenario = await loadScenario();
const terrain = await readTerrain(scenario.elevationBytes, scenario.manifest);
const result = generateTrajectory(scenario.input, terrain, scenario.manifest);
await mkdir(destination, { recursive: true });
await writeFile(new URL("defaults.json", destination), JSON.stringify(scenario.input));
for (const name of ["elevation.tif", "hillshade.tif", "manifest.json", "geoid-egm2008.json"]) {
  await copyFile(new URL(`../terrain/odesa/${name}`, import.meta.url), new URL(name, destination));
}
await writeFile(new URL("trajectory_truth.json", destination), JSON.stringify(result));
console.log(`Prepared Odesa replay: ${result.trajectory_truth.length} states + terminal state`);
