import { TICK_MS } from "./validation.mjs";
import { TerrainError } from "./terrain.mjs";

export const ENGINE_VERSION = "synthetic-truth-1.0.0";
export const EARTH_RADIUS_M = 6371008.8;
const DEG = Math.PI / 180;
const wrap = (heading) => ((heading % 360) + 360) % 360;
const turnDifference = (target, current) => ((target - current + 540) % 360) - 180;

// Mulberry32: fixed draw schedule, independent of exported sample frequency.
function randomGenerator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// Generic spherical-Earth displacement, not an aircraft performance model.
export function advance(longitude, latitude, heading, distanceM) {
  const lon = longitude * DEG, lat = latitude * DEG, bearing = heading * DEG;
  const arc = distanceM / EARTH_RADIUS_M;
  const nextLat = Math.asin(Math.sin(lat) * Math.cos(arc) + Math.cos(lat) * Math.sin(arc) * Math.cos(bearing));
  const nextLon = lon + Math.atan2(Math.sin(bearing) * Math.sin(arc) * Math.cos(lat),
    Math.cos(arc) - Math.sin(lat) * Math.sin(nextLat));
  return [((nextLon / DEG + 540) % 360) - 180, nextLat / DEG];
}

export function generateTrajectoryCore(input, terrain, manifest, hashes) {
  const random = randomGenerator(input.simulation.seed);
  const speed = input.initial_state.ground_speed_mps;
  let lon = input.initial_state.longitude_deg, lat = input.initial_state.latitude_deg;
  let heading = input.initial_state.heading_deg;
  const altitude = terrain.sample(lon, lat) + input.initial_state.height_above_surface_m;
  const durationMs = Math.round(input.simulation.duration_s * 1000);
  const outputMs = Math.round(input.simulation.output_interval_s * 1000);
  const commandMs = Math.round(input.movement.heading_change_interval_s * 1000);
  const startMs = Date.parse(input.simulation.start_time);
  // At most half of the smaller grid spacing per internal movement step.
  const maxAbsLat = Math.max(Math.abs(terrain.bounds[1]), Math.abs(terrain.bounds[3]));
  const cellM = Math.min(terrain.dy, terrain.dx * Math.cos(maxAbsLat * DEG)) * DEG * EARTH_RADIUS_M;
  const subdivisions = Math.max(1, Math.ceil(speed * TICK_MS / 1000 / (cellM / 2)));
  const stepCount = durationMs / TICK_MS * subdivisions;
  if (!Number.isFinite(stepCount) || stepCount > 2000000) {
    throw new TerrainError("STEP_BUDGET", "Scenario requires more than 2000000 validation steps; reduce duration or speed");
  }
  let targetHeading = heading;
  let minClearance = Infinity, maxSurface = -Infinity, checkedPositions = 0;
  const states = [];
  let terminalState;

  function inspect(elapsedMs) {
    let surface;
    try {
      surface = terrain.sample(lon, lat);
    } catch (error) {
      if (error instanceof TerrainError) error.details.elapsed_s = elapsedMs / 1000;
      throw error;
    }
    const clearance = altitude - surface;
    if (clearance < input.validation.minimum_surface_clearance_m) {
      throw new TerrainError("CLEARANCE", "Trajectory violates minimum surface clearance", {
        elapsed_s: elapsedMs / 1000, longitude_deg: lon, latitude_deg: lat,
        height_above_surface_m: clearance, required_m: input.validation.minimum_surface_clearance_m
      });
    }
    checkedPositions++;
    minClearance = Math.min(minClearance, clearance);
    maxSurface = Math.max(maxSurface, surface);
    return {
      timestamp: new Date(startMs + elapsedMs).toISOString(),
      elapsed_s: elapsedMs / 1000,
      object_id: input.object_id,
      longitude_deg: lon, latitude_deg: lat,
      altitude_egm2008_m: altitude,
      surface_elevation_egm2008_m: surface,
      height_above_surface_m: clearance,
      ground_speed_mps: speed,
      heading_deg: heading
    };
  }

  let current = inspect(0);
  for (let elapsedMs = 0; elapsedMs < durationMs; elapsedMs += TICK_MS) {
    if (elapsedMs % outputMs === 0) states.push(current);
    if (elapsedMs % commandMs === 0) targetHeading = random() * 360;
    const dt = TICK_MS / 1000 / subdivisions;
    for (let sub = 1; sub <= subdivisions; sub++) {
      const difference = turnDifference(targetHeading, heading);
      const limit = input.movement.max_heading_rate_deg_s * dt;
      const delta = Math.max(-limit, Math.min(limit, difference));
      [lon, lat] = advance(lon, lat, wrap(heading + delta / 2), speed * dt);
      heading = wrap(heading + delta);
      current = inspect(elapsedMs + sub * TICK_MS / subdivisions);
    }
    terminalState = current;
  }

  return {
    schema_version: "1.0", content: "trajectory_truth",
    engine: {
      version: ENGINE_VERSION, model: "generic synthetic kinematics",
      horizontal_geometry: "spherical Earth", earth_radius_m: EARTH_RADIUS_M,
      clock_tick_s: TICK_MS / 1000, integration_subdivisions_per_tick: subdivisions,
      random_generator: "mulberry32",
      heading_commands: "uniform [0,360) at fixed command intervals; shortest signed turn with bounded rate"
    },
    coordinates: manifest.coordinates,
    provenance: {
      terrain_id: manifest.terrain_id,
      elevation_sha256: manifest.assets.surface_elevation.sha256,
      manifest_sha256: hashes.manifest, input_sha256: hashes.input,
      hash_encoding: "UTF-8 JSON.stringify for input and manifest; original file bytes for elevation",
      dataset: manifest.dataset, attribution: manifest.attribution
    },
    resolved_input: input,
    validation: {
      status: "pass", output_state_count: states.length, checked_position_count: checkedPositions,
      validated_through_elapsed_s: input.simulation.duration_s,
      maximum_validation_step_s: TICK_MS / 1000 / subdivisions,
      maximum_validation_step_distance_m: speed * TICK_MS / 1000 / subdivisions,
      minimum_surface_clearance_m: minClearance, maximum_sampled_surface_elevation_m: maxSurface,
      modeled_distance_m: speed * input.simulation.duration_s, terminal_state: terminalState
    },
    limitations: [
      "Generic synthetic movement parameters; aircraft performance is not validated.",
      "Surface checks occur at internal integration positions; continuous clearance between checks is not proven.",
      "DSM includes vegetation and structures; no authoritative water mask is supplied.",
      "Zero and negative elevations are preserved; finite values alone do not establish source validity.",
      "Altitudes use EGM2008; conversion to ellipsoidal heights is required for Cesium or CoT HAE."
    ],
    trajectory_truth: states
  };
}
