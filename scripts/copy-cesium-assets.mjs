/**
 * Copies CesiumJS's static runtime assets (Workers, Assets, Widgets, ThirdParty)
 * out of node_modules into public/cesium so both `vite dev` and `vite build`
 * can serve them from CESIUM_BASE_URL === '/cesium'.
 *
 * Runs on postinstall/predev/prebuild. Skips work when already up to date.
 */
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(import.meta.dirname, "..");
const outDir = path.join(projectRoot, "public", "cesium");
const stampFile = path.join(outDir, ".version");
const DIRS = ["Workers", "Assets", "Widgets", "ThirdParty"];

const cesiumPkgPath = require.resolve("cesium/package.json");
const cesiumRoot = path.dirname(cesiumPkgPath);
const cesiumBuild = path.join(cesiumRoot, "Build", "Cesium");
const { version } = JSON.parse(await readFile(cesiumPkgPath, "utf8"));

const exists = async (p) => !!(await stat(p).catch(() => null));

if (!(await exists(cesiumBuild))) {
  console.error(`[cesium] Build/Cesium not found at ${cesiumBuild}`);
  process.exit(1);
}

const stamp = await readFile(stampFile, "utf8").catch(() => null);
if (stamp === version) {
  console.log(`[cesium] assets already current (v${version})`);
  process.exit(0);
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

for (const dir of DIRS) {
  const from = path.join(cesiumBuild, dir);
  if (!(await exists(from))) continue;
  await cp(from, path.join(outDir, dir), { recursive: true });
}

await writeFile(stampFile, version);
console.log(`[cesium] copied ${DIRS.join(", ")} for v${version} -> public/cesium`);
