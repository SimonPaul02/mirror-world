import assert from './assert.mjs';
import { createSampler } from './terrain.mjs';

/** Receiver contract: elapsed seconds, WGS84 lat/lon, WGS84 ellipsoidal metres. */
export function toReceiverGroundTruth(output, { scenarioId, geoid }) {
  assert(typeof scenarioId === 'string' && scenarioId.trim().length > 0, 'scenario_id is required');
  assert.equal(output.content, 'trajectory_truth', 'Expected a trajectory_truth export');
  assert.equal(output.coordinates.horizontal_crs, 'EPSG:4326', 'Expected WGS84 longitude/latitude');
  assert.equal(output.coordinates.vertical_crs, 'EPSG:3855', 'Expected EGM2008 input heights');
  assert.equal(output.coordinates.vertical_reference, 'EGM2008');
  assert.equal(output.validation.status, 'pass', 'Only validated trajectories may be exported');
  assert.equal(geoid.band_metadata?.DESCRIPTION, 'geoid_undulation', 'Expected a geoid undulation grid');
  assert.equal(geoid.band_metadata?.UNITTYPE, 'metre', 'Expected geoid undulation in metres');
  const sample = createSampler(geoid).sample;
  const period = output.resolved_input.simulation.output_interval_s;
  const startMs = Date.parse(output.resolved_input.simulation.start_time);
  assert(Number.isFinite(period) && period > 0, 'sample_period_s must be positive');
  assert(Number.isFinite(startMs), 'Scenario UTC start time is invalid');
  assert(Array.isArray(output.trajectory_truth) && output.trajectory_truth.length > 0, 'Trajectory has no samples');
  const ground_truth = output.trajectory_truth.map((state, index) => {
    const { elapsed_s, object_id, latitude_deg, longitude_deg, altitude_egm2008_m } = state;
    assert([elapsed_s, latitude_deg, longitude_deg, altitude_egm2008_m].every(Number.isFinite), 'Nonfinite truth value');
    assert(typeof object_id === 'string' && object_id.length > 0, 'object_id is required');
    assert(Math.abs(elapsed_s - index * period) < 1e-7, 'Truth samples must start at zero and match sample_period_s');
    assert(Math.abs(Date.parse(state.timestamp) - (startMs + elapsed_s * 1000)) < 0.01, 'UTC and elapsed timestamps disagree');
    assert(latitude_deg >= -90 && latitude_deg <= 90 && longitude_deg >= -180 && longitude_deg <= 180,
      'Invalid WGS84 coordinates');
    const hae_m = altitude_egm2008_m + sample(longitude_deg, latitude_deg);
    assert(Number.isFinite(hae_m), 'Ellipsoidal height is not finite');
    return { timestamp_s: elapsed_s, object_id, lat: latitude_deg, lon: longitude_deg, hae_m };
  });
  // Preserve export cadence and count. The separately validated terminal state is not appended.
  return { scenario_id: scenarioId.trim(), sample_period_s: period, ground_truth };
}
