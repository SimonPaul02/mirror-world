import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadScenario, validateConfig } from "../engine/config.mjs";
import { createSampler, readTerrain } from "../engine/terrain.mjs";
import { generateTrajectory, EARTH_RADIUS_M } from "../engine/trajectory.mjs";

const scenario = await loadScenario();
const realTerrain = await readTerrain(scenario.elevationBytes, scenario.manifest);
const copyInput = () => structuredClone(scenario.input);
const run = (input = copyInput(), terrain = realTerrain) => generateTrajectory(input, terrain, scenario.manifest);
const near = (actual, expected, tolerance = 1e-7) => assert(Math.abs(actual - expected) <= tolerance,
  `${actual} differs from ${expected} by more than ${tolerance}`);

test("sample-center interpolation follows an analytical plane and preserves edges", () => {
  // Elevation = 10 * longitude + 20 * latitude on this grid.
  const terrain = createSampler({ values: [40, 50, 60, 20, 30, 40, 0, 10, 20],
    width: 3, height: 3, west: 0, north: 2, dx: 1, dy: 1 });
  near(terrain.sample(0.25, 1.4), 30.5);
  near(terrain.sample(0, 2), 40);
  near(terrain.sample(2, 0), 20);
  assert.throws(() => terrain.sample(-0.001, 1), { code: "OUT_OF_BOUNDS" });
});

test("missing elevations fail, while zero and negative elevations remain usable", () => {
  const terrain = createSampler({ values: [0, -10, NaN, 20], width: 2, height: 2,
    west: 0, north: 1, dx: 1, dy: 1 });
  near(terrain.sample(0, 1), 0);
  near(terrain.sample(1, 1), -10);
  assert.throws(() => terrain.sample(0.5, 0.5), { code: "MISSING_ELEVATION" });
  const declared = createSampler({ values: [0, -9999, 1, 2], width: 2, height: 2,
    west: 0, north: 1, dx: 1, dy: 1, nodata: -9999 });
  assert.throws(() => declared.sample(1, 1), { code: "MISSING_ELEVATION" });
});

test("real GeoTIFF samples match independent Pillow inspection without half-pixel shift", () => {
  const [west, north] = scenario.manifest.grid.sample_origin_lon_lat;
  const [dx, dy] = scenario.manifest.grid.pixel_size_degrees;
  // These reference values were decoded independently with Pillow from the archive member.
  near(realTerrain.sample(west, north), 76.4645767211914);
  near(realTerrain.sample(west + 360 * dx, north - 720 * dy), 57.070316314697266);
  near(realTerrain.sample(west + 800 * dx, north - 400 * dy), 23.287939071655273);
  near(realTerrain.sample(realTerrain.bounds[2], realTerrain.bounds[1]), 0);
  const expectedMean = (57.070316314697266 + 56.50902557373047 + 56.57118225097656 + 55.85520553588867) / 4;
  near(realTerrain.sample(west + 360.5 * dx, north - 720.5 * dy), expectedMean);
});

test("Odesa output has consistent time, speed, heading, altitude and clearance", () => {
  const result = run();
  const states = result.trajectory_truth;
  assert.equal(states.length, 300);
  assert.equal(result.validation.checked_position_count, 3001);
  assert.equal(result.validation.terminal_state.elapsed_s, 300);
  const start = Date.parse(scenario.input.simulation.start_time);
  const movement = scenario.input.movement;
  const vertical = movement.altitude_mode === "smooth_random_agl";
  const band = movement.height_band_m ?? [];
  // Consecutive exports are a chord of a curving path, so the straight-line
  // distance falls short of the 50 m arc by about (turn per sample)^2 / 24.
  // Deriving the tolerance keeps this tight when the turn rate changes.
  const turnPerSample = movement.max_heading_rate_deg_s *
    scenario.input.simulation.output_interval_s * Math.PI / 180;
  const chordTolerance = 50 * turnPerSample ** 2 / 24 + 1e-5;
  const turnPerExport = movement.max_heading_rate_deg_s * scenario.input.simulation.output_interval_s;
  for (let i = 0; i < states.length; i++) {
    const s = states[i];
    assert.equal(Date.parse(s.timestamp), start + i * 1000);
    assert.equal(s.elapsed_s, i);
    if (vertical) {
      // Commands stay inside the band, and the climb between exports respects
      // the configured rate over the one-second export interval.
      assert(s.commanded_height_above_surface_m >= band[0] - 1e-9 &&
        s.commanded_height_above_surface_m <= band[1] + 1e-9);
      if (i > 0) assert(Math.abs(s.altitude_egm2008_m - states[i - 1].altitude_egm2008_m) <=
        movement.max_climb_rate_mps * 1 + 1e-6, "climb rate exceeded between exports");
    } else {
      assert.equal(s.altitude_egm2008_m, states[0].altitude_egm2008_m);
    }
    near(s.altitude_egm2008_m - s.surface_elevation_egm2008_m, s.height_above_surface_m);
    assert(s.height_above_surface_m >= 100);
    if (i === 0) continue;
    const prev = states[i - 1], rad = Math.PI / 180;
    // Independent haversine distance between exported positions.
    const dlat = (s.latitude_deg - prev.latitude_deg) * rad;
    const dlon = (s.longitude_deg - prev.longitude_deg) * rad;
    const a = Math.sin(dlat / 2) ** 2 + Math.cos(prev.latitude_deg * rad) *
      Math.cos(s.latitude_deg * rad) * Math.sin(dlon / 2) ** 2;
    near(2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a)), 50, chordTolerance);
    assert(Math.abs(((s.heading_deg - prev.heading_deg + 540) % 360) - 180) <= turnPerExport + 1e-9,
      "heading rate exceeded between exports");
  }
});

test("the seed shapes the vertical profile, not only the ground track", () => {
  const heights = run().trajectory_truth.map(s => s.height_above_surface_m);
  const spread = Math.max(...heights) - Math.min(...heights);
  assert(spread > 200, `vertical profile is flat: ${spread.toFixed(1)} m of spread`);

  // A different seed must move the altitudes, or the seed is not reaching them.
  const other = copyInput();
  other.simulation.seed = scenario.input.simulation.seed + 1;
  const otherHeights = run(other).trajectory_truth.map(s => s.height_above_surface_m);
  assert(heights.some((h, i) => Math.abs(h - otherHeights[i]) > 1),
    "changing the seed left the vertical profile untouched");
});

test("seed is reproducible and export frequency does not change the generated path", () => {
  const first = run();
  assert.equal(JSON.stringify(first), JSON.stringify(run()));
  const different = copyInput(); different.simulation.seed++;
  assert.notDeepEqual(first.trajectory_truth, run(different).trajectory_truth);
  const sparse = copyInput(); sparse.simulation.output_interval_s = 10;
  assert.deepEqual(run(sparse).trajectory_truth, first.trajectory_truth.filter((_, i) => i % 10 === 0));
});

test("a clearance violation between exported timestamps is rejected", () => {
  const input = copyInput();
  Object.assign(input.initial_state, { longitude_deg: 0, latitude_deg: 0 });
  Object.assign(input.simulation, { duration_s: 2, output_interval_s: 1 });
  input.movement.max_heading_rate_deg_s = 0.000001;
  const terrain = { bounds: [-1, -1, 1, 1], dx: 0.001, dy: 0.001,
    sample: (lon) => lon > 0.00015 && lon < 0.00025 ? 2000 : 0 };
  assert.throws(() => run(input, terrain), (error) => error.code === "CLEARANCE" &&
    error.details.elapsed_s > 0 && error.details.elapsed_s < 1);
});

test("the final interval is validated even when only t=0 is exported", () => {
  const input = copyInput();
  Object.assign(input.initial_state, { longitude_deg: 0, latitude_deg: 0 });
  Object.assign(input.simulation, { duration_s: 1, output_interval_s: 1 });
  input.movement.max_heading_rate_deg_s = 0.000001;
  const terrain = createSampler({ values: [0, 0, 0, 0], width: 2, height: 2,
    west: -0.0005, north: 0.001, dx: 0.0007, dy: 0.002 });
  assert.throws(() => run(input, terrain), (error) => error.code === "OUT_OF_BOUNDS" &&
    error.details.elapsed_s > 0 && error.details.elapsed_s < 1);
});

test("input rejects unknown options, unsupported time precision, invalid dates and full day", () => {
  for (const mutate of [
    (i) => { i.movement.unknown = true; },
    (i) => { i.simulation.output_interval_s = 0.01; },
    (i) => { i.simulation.duration_s = 86400; },
    (i) => { i.simulation.start_time = "2026-02-30T12:00:00Z"; },
    (i) => { i.output.vertical_crs = "EPSG:4979"; }
  ]) {
    const input = copyInput(); mutate(input);
    assert.throws(() => validateConfig(input, scenario.manifest));
  }
});

test("CLI failure writes no partial output and preserves a previous result", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mirror-world-engine-"));
  try {
    const input = copyInput();
    input.terrain_manifest = scenario.manifestPath;
    input.initial_state.longitude_deg = realTerrain.bounds[2] - 0.000001;
    Object.assign(input.simulation, { duration_s: 1, output_interval_s: 1 });
    const inputPath = path.join(dir, "input.json"), outputPath = path.join(dir, "output.json");
    await writeFile(inputPath, JSON.stringify(input));
    const cli = fileURLToPath(new URL("../generate.mjs", import.meta.url));
    const invoke = () => spawnSync(process.execPath, [cli, inputPath, outputPath], { encoding: "utf8" });
    const first = invoke();
    assert.equal(first.status, 1);
    assert.equal(JSON.parse(first.stderr).code, "OUT_OF_BOUNDS");
    assert.equal(existsSync(outputPath), false);
    await writeFile(outputPath, "previous result");
    assert.equal(invoke().status, 1);
    assert.equal(await readFile(outputPath, "utf8"), "previous result");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
