import { TICK_MS } from "./validation.mjs";
import { TerrainError } from "./terrain.mjs";

export const ENGINE_VERSION = "synthetic-truth-1.0.0";
export const EARTH_RADIUS_M = 6371008.8;
const DEG = Math.PI / 180;
const wrap = (heading) => ((heading % 360) + 360) % 360;
const turnDifference = (target, current) => ((target - current + 540) % 360) - 180;

// Holding the rate limit until the command is met and then stopping dead is the
// fastest way to get there, but it leaves a corner at both ends of every
// manoeuvre. Inside these bands the rate backs off smoothly instead, which
// rounds the track and the vertical profile without loosening either limit.
const HEADING_EASE_DEG = 30;
const HEIGHT_EASE_M = 150;
// Commands are drawn inside this share of what the rate limit can deliver in a
// command interval, so a manoeuvre finishes and the rate eases back to zero
// before the next command. Drawing the full reachable amount leaves the
// aircraft still turning when the next one lands, which reverses the rate hard.
const SETTLE = 0.5;
// Smoothstep: zero slope at both ends, so the rate has no discontinuity.
const ease = (error, band) => {
  const x = Math.min(1, Math.abs(error) / band);
  return x * x * (3 - 2 * x);
};

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
  let altitude = terrain.sample(lon, lat) + input.initial_state.height_above_surface_m;
  // Vertical counterpart of the heading law. Drawn from the same stream, so a
  // seed picks the whole shape of the flight rather than only its ground track.
  const vertical = input.movement.altitude_mode === "smooth_random_agl";
  const [bandLow, bandHigh] = vertical ? input.movement.height_band_m : [0, 0];
  const climbRate = vertical ? input.movement.max_climb_rate_mps : 0;
  // Same reachability rule as the heading walk: a step the climb rate cannot
  // fly within the interval saturates the rate and reverses hard at the next
  // command. The configured step is the ceiling; physics sets the rest.
  const heightStep = vertical
    ? Math.min(input.movement.height_step_m, climbRate * input.movement.altitude_change_interval_s * SETTLE)
    : 0;
  let targetHeight = input.initial_state.height_above_surface_m;
  const durationMs = Math.round(input.simulation.duration_s * 1000);
  const outputMs = Math.round(input.simulation.output_interval_s * 1000);
  const commandMs = Math.round(input.movement.heading_change_interval_s * 1000);
  const altitudeMs = vertical ? Math.round(input.movement.altitude_change_interval_s * 1000) : 0;
  const reachableDeg = input.movement.max_heading_rate_deg_s * input.movement.heading_change_interval_s * SETTLE;
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

  function inspect(elapsedMs, stepSeconds = 0) {
    let surface;
    try {
      surface = terrain.sample(lon, lat);
    } catch (error) {
      if (error instanceof TerrainError) error.details.elapsed_s = elapsedMs / 1000;
      throw error;
    }
    if (vertical && stepSeconds > 0) {
      const error = surface + targetHeight - altitude;
      const limit = climbRate * stepSeconds * ease(error, HEIGHT_EASE_M);
      altitude += Math.max(-limit, Math.min(limit, error));
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
      heading_deg: heading,
      ...(vertical ? { commanded_height_above_surface_m: targetHeight } : {})
    };
  }

  let current = inspect(0);
  for (let elapsedMs = 0; elapsedMs < durationMs; elapsedMs += TICK_MS) {
    if (elapsedMs % outputMs === 0) states.push(current);
    // A command the turn rate cannot reach within the interval is not a
    // destination, it is a direction to lean into: the aircraft holds the rate
    // limit for the whole leg and corners whenever the error changes sign.
    // Drawing inside the reachable arc makes every command attainable, so the
    // easing above actually engages and the track curves instead of folding.
    if (elapsedMs % commandMs === 0) targetHeading = wrap(heading + (random() * 2 - 1) * reachableDeg);
    // A bounded walk rather than an independent draw: redrawing uniformly across
    // the band sends the aircraft diving at its rate limit every command, which
    // reads as a plunge rather than a flight. Reflecting at the band edges keeps
    // the walk from loitering against a clamp.
    if (vertical && elapsedMs % altitudeMs === 0) {
      let next = targetHeight + (random() * 2 - 1) * heightStep;
      if (next < bandLow) next = bandLow + (bandLow - next);
      if (next > bandHigh) next = bandHigh - (next - bandHigh);
      targetHeight = Math.max(bandLow, Math.min(bandHigh, next));
    }
    const dt = TICK_MS / 1000 / subdivisions;
    for (let sub = 1; sub <= subdivisions; sub++) {
      const difference = turnDifference(targetHeading, heading);
      const limit = input.movement.max_heading_rate_deg_s * dt * ease(difference, HEADING_EASE_DEG);
      const delta = Math.max(-limit, Math.min(limit, difference));
      [lon, lat] = advance(lon, lat, wrap(heading + delta / 2), speed * dt);
      heading = wrap(heading + delta);
      current = inspect(elapsedMs + sub * TICK_MS / subdivisions, dt);
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
      heading_commands: `heading walks by at most max_heading_rate_deg_s * heading_change_interval_s (${reachableDeg} degrees) per command; shortest signed turn with bounded rate, eased within ${HEADING_EASE_DEG} degrees of the command`,
      altitude_commands: vertical
        ? `height above surface walks by at most ${heightStep} m per command (height_step_m capped by max_climb_rate_mps * altitude_change_interval_s), reflected into height_band_m; bounded climb rate toward the commanded height, eased within ${HEIGHT_EASE_M} m`
        : "constant EGM2008 altitude"
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
