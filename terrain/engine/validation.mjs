import assert from "./assert.mjs";

export const TICK_MS = 100;
const finite = (value, name) => assert(Number.isFinite(value), `${name} must be finite`);
function keys(object, required, name) {
  assert(object && typeof object === "object" && !Array.isArray(object), `${name} must be an object`);
  assert.deepEqual(Object.keys(object).sort(), [...required].sort(), `${name}: missing or unsupported fields`);
}
function tickAligned(seconds, name) {
  finite(seconds, name);
  assert(seconds > 0 && Math.abs(seconds * 10 - Math.round(seconds * 10)) < 1e-8,
    `${name} must be a positive multiple of 0.1 seconds`);
}

export function validateConfig(input, manifest) {
  keys(input, ["schema_version", "purpose", "terrain_id", "terrain_manifest", "object_id",
    "initial_state", "simulation", "movement", "validation", "output"], "input");
  assert.equal(input.schema_version, "1.0");
  assert.equal(input.purpose, "offline_synthetic_trajectory_truth");
  assert(typeof input.object_id === "string" && input.object_id.length > 0, "object_id is required");
  assert(typeof input.terrain_manifest === "string" && input.terrain_manifest.length > 0);
  assert.equal(manifest.schema_version, "1.0");
  assert.equal(input.terrain_id, manifest.terrain_id, "terrain_id must match the manifest");
  assert.equal(manifest.coordinates.horizontal_crs, "EPSG:4326");
  assert.equal(manifest.coordinates.vertical_crs, "EPSG:3855");
  assert.equal(manifest.coordinates.vertical_reference, "EGM2008");
  assert.equal(manifest.coordinates.vertical_reference_evidence, "provider_documentation");
  const state = input.initial_state;
  keys(state, ["longitude_deg", "latitude_deg", "height_above_surface_m", "ground_speed_mps", "heading_deg"], "initial_state");
  for (const [name, value] of Object.entries(state)) finite(value, name);
  const [west, south, east, north] = manifest.grid.sample_center_bounds_wsen;
  assert(state.longitude_deg >= west && state.longitude_deg <= east &&
    state.latitude_deg >= south && state.latitude_deg <= north,
  "Initial position lies outside the raster sample-center bounds");
  assert(state.heading_deg >= 0 && state.heading_deg < 360, "heading_deg must be in [0, 360)");
  assert(state.ground_speed_mps > 0, "ground_speed_mps must be positive");
  keys(input.validation, ["minimum_surface_clearance_m", "out_of_bounds", "missing_elevation"], "validation");
  finite(input.validation.minimum_surface_clearance_m, "minimum_surface_clearance_m");
  assert(input.validation.minimum_surface_clearance_m > 0);
  assert(state.height_above_surface_m >= input.validation.minimum_surface_clearance_m,
    "Initial surface clearance is below the configured minimum");
  assert.equal(input.validation.out_of_bounds, "reject");
  assert.equal(input.validation.missing_elevation, "reject");
  const sim = input.simulation;
  keys(sim, ["start_time", "duration_s", "output_interval_s", "end_inclusive", "seed"], "simulation");
  assert(typeof sim.start_time === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(sim.start_time),
    "start_time must be an ISO UTC timestamp with seconds and optional milliseconds");
  const start = Date.parse(sim.start_time);
  assert(Number.isFinite(start), "Invalid start_time");
  assert.equal(new Date(start).toISOString(), sim.start_time.includes(".") ? sim.start_time : sim.start_time.replace("Z", ".000Z"),
    "Invalid calendar date in start_time");
  tickAligned(sim.duration_s, "duration_s");
  tickAligned(sim.output_interval_s, "output_interval_s");
  assert(sim.duration_s < 86400, "duration_s must be less than 86400");
  assert(sim.output_interval_s <= sim.duration_s, "output_interval_s exceeds duration_s");
  assert(Math.ceil(sim.duration_s / sim.output_interval_s) <= 200000,
    "Output exceeds 200000 states; increase output_interval_s");
  assert(Number.isInteger(sim.seed) && sim.seed >= 0 && sim.seed <= 0xffffffff,
    "seed must be an unsigned 32-bit integer");
  assert.equal(sim.end_inclusive, false);
  const movement = input.movement;
  keys(movement, ["model", "heading_mode", "speed_mode", "altitude_mode",
    "max_heading_rate_deg_s", "heading_change_interval_s"], "movement");
  assert.equal(movement.model, "generic_synthetic");
  assert.equal(movement.heading_mode, "smooth_random");
  assert.equal(movement.speed_mode, "constant");
  assert.equal(movement.altitude_mode, "constant_egm2008_height");
  finite(movement.max_heading_rate_deg_s, "max_heading_rate_deg_s");
  assert(movement.max_heading_rate_deg_s > 0 && movement.max_heading_rate_deg_s <= 180,
    "max_heading_rate_deg_s must be in (0, 180]");
  tickAligned(movement.heading_change_interval_s, "heading_change_interval_s");
  keys(input.output, ["format", "content", "horizontal_crs", "vertical_crs", "altitude_field", "surface_clearance_field"], "output");
  assert.equal(input.output.format, "json");
  assert.equal(input.output.content, "trajectory_truth");
  assert.equal(input.output.horizontal_crs, manifest.coordinates.horizontal_crs);
  assert.equal(input.output.vertical_crs, manifest.coordinates.vertical_crs);
  assert.equal(input.output.altitude_field, "altitude_egm2008_m");
  assert.equal(input.output.surface_clearance_field, "height_above_surface_m");
}
