/**
 * Stages every available flight area into public/ for the replay lab: terrain,
 * geoid, a validated generator input and a ready-made trajectory per region,
 * plus the catalog the region picker reads.
 *
 * Packaged regions come from terrain/<id>/ and are checked in. Fetched regions
 * come from terrain/regions/<id>/ and are built by scripts/fetch-regions.mjs;
 * if they are absent they are skipped, so a fresh clone still runs on the
 * packaged Odesa crop alone.
 */
import assert from "node:assert/strict";
import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadScenario, sha256 } from "../terrain/engine/config.mjs";
import { validateConfig } from "../terrain/engine/validation.mjs";
import { readTerrain } from "../terrain/engine/terrain.mjs";
import { generateTrajectory } from "../terrain/engine/trajectory.mjs";

const ROOT = new URL("../", import.meta.url);
const ASSETS = ["elevation.tif", "hillshade.tif", "manifest.json", "geoid-egm2008.json"];
const catalog = JSON.parse(await readFile(new URL("terrain/regions.json", ROOT), "utf8"));
// The packaged Odesa input is the template every region starts from, so the
// flight model stays identical and only the area and its heights differ.
const template = (await loadScenario()).input;

function inputFor(region, manifest) {
  const [west, south, east, north] = manifest.grid.sample_center_bounds_wsen;
  const input = structuredClone(template);
  input.terrain_id = manifest.terrain_id;
  input.terrain_manifest = "manifest.json";
  // Centre the start: a 300 s leg covers 15 km, and the shortest box side is
  // about 30 km, so the aircraft has room before it can reach an edge.
  Object.assign(input.initial_state, {
    longitude_deg: Number(((west + east) / 2).toFixed(6)),
    latitude_deg: Number(((south + north) / 2).toFixed(6)),
    height_above_surface_m: region.flight.height_above_surface_m
  });
  Object.assign(input.movement, {
    height_band_m: region.flight.height_band_m,
    max_climb_rate_mps: region.flight.max_climb_rate_mps
  });
  return input;
}

async function stage(region) {
  const dir = new URL(region.packaged ? `terrain/odesa/` : `terrain/regions/${region.id}/`, ROOT);
  if (!existsSync(fileURLToPath(new URL("manifest.json", dir)))) return undefined;

  const manifest = JSON.parse(await readFile(new URL("manifest.json", dir), "utf8"));
  let elevationBytes;
  for (const [role, asset] of Object.entries(manifest.assets)) {
    const bytes = await readFile(new URL(asset.path, dir));
    assert.equal(bytes.length, asset.size_bytes, `${region.id}/${asset.path}: size mismatch`);
    assert.equal(sha256(bytes), asset.sha256, `${region.id}/${asset.path}: checksum mismatch`);
    if (role === "surface_elevation") elevationBytes = bytes;
  }

  const terrain = await readTerrain(elevationBytes, manifest);
  // A 300 s leg covers 15 km and the shortest box half-width is about 14.5 km,
  // so a wandering heading can just reach an edge. Rather than shorten every
  // region's default, take the first seed whose whole path stays inside; the
  // chosen seed is recorded in the catalog so the default stays reproducible.
  let input, result, seed = template.simulation.seed;
  for (const candidate of Array.from({ length: 64 }, (_, i) => template.simulation.seed + i)) {
    input = inputFor(region, manifest);
    input.simulation.seed = candidate;
    validateConfig(input, manifest);
    try {
      result = generateTrajectory(input, terrain, manifest);
      seed = candidate;
      break;
    } catch (error) {
      if (error.code !== "OUT_OF_BOUNDS" && error.code !== "CLEARANCE") throw error;
      result = undefined;
    }
  }
  assert(result, `${region.id}: no seed in range kept the path inside the box`);

  const out = new URL(`public/trajectory/${region.id}/`, ROOT);
  await mkdir(out, { recursive: true });
  for (const name of ASSETS) await copyFile(new URL(name, dir), new URL(name, out));
  await writeFile(new URL("defaults.json", out), JSON.stringify(input));
  await writeFile(new URL("trajectory_truth.json", out), JSON.stringify(result));

  const heights = result.trajectory_truth.map(s => s.height_above_surface_m);
  return {
    id: region.id, name: region.name, blurb: region.blurb, seed,
    relief_m: Math.round(manifest.inspection.maximum_elevation_m - manifest.inspection.minimum_elevation_m),
    elevation_range_m: [Math.round(manifest.inspection.minimum_elevation_m),
      Math.round(manifest.inspection.maximum_elevation_m)],
    bounds_wsen: manifest.grid.sample_center_bounds_wsen,
    minimum_clearance_m: Math.round(result.validation.minimum_surface_clearance_m),
    agl_spread_m: Math.round(Math.max(...heights) - Math.min(...heights))
  };
}

const regions = [];
for (const region of catalog.regions) {
  try {
    const entry = await stage(region);
    if (!entry) { console.log(`${region.id.padEnd(17)} skipped (not fetched)`); continue; }
    regions.push(entry);
    console.log(`${entry.id.padEnd(17)} relief ${String(entry.relief_m).padStart(4)} m  ` +
      `min clearance ${String(entry.minimum_clearance_m).padStart(4)} m  ` +
      `AGL spread ${String(entry.agl_spread_m).padStart(4)} m  seed ${entry.seed}`);
  } catch (error) {
    console.log(`${region.id.padEnd(17)} FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
assert(regions.length > 0, "No regions could be prepared");
await writeFile(new URL("public/trajectory/regions.json", ROOT),
  JSON.stringify({ schema_version: "1.0", default: regions[0].id, regions }, null, 2) + "\n");
console.log(`\nPrepared ${regions.length} region(s); default ${regions[0].id}.`);
