import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadScenario } from "../terrain/engine/config.mjs";
import { generateTrajectory } from "../terrain/engine/trajectory.mjs";
import { toReceiverGroundTruth } from "../terrain/engine/receiver-adapter.mjs";
import { loadRfTerrain } from "../scripts/load-rf-terrain.mjs";
import { generateRfScenario } from "../src/sensor-generator.ts";
import { parseTrajectory } from "../src/trajectory.ts";
import { Cartographic } from "cesium";

const source = await loadScenario();
const terrain = await loadRfTerrain(source.manifestPath);
const truth = generateTrajectory(source.input, terrain.surface, source.manifest);
const trajectory = { ...toReceiverGroundTruth(truth, { scenarioId: "odesa_rf_001", geoid: terrain.geoidGrid }), start_utc: source.input.simulation.start_time, duration_s: source.input.simulation.duration_s };
const config = JSON.parse(readFileSync("examples/rf_sensor_odesa.json", "utf8"));

test("the actual team export passes our importer with the original UTC clock", () => {
  const parsed = parseTrajectory(trajectory);
  assert.equal(parsed.ground_truth.length, 300);
  assert.equal(parsed.start_utc, "2026-10-18T12:00:00Z");
  assert.equal(parsed.duration_s, 300);
  assert.equal(parsed.ground_truth[299].timestamp_s, 299);
});

test("real RF terrain uses the same EGM2008-to-ellipsoid conversion as the drone export", () => {
  for (const index of [0, 150, 299]) {
    const point = trajectory.ground_truth[index];
    const groundHae = terrain.verified.sample(Cartographic.fromDegrees(point.lon, point.lat));
    const expectedClearance = truth.trajectory_truth[index].height_above_surface_m;
    assert.ok(Math.abs((point.hae_m - groundHae) - expectedClearance) < 1e-8);
  }
  assert.equal(terrain.verified.sample(Cartographic.fromDegrees(0, 0)), undefined);
});

test("real terrain produces a complete five-minute RF trace and defensible receiver geometry", () => {
  const generated = generateRfScenario(trajectory, config, terrain.verified);
  assert.equal(generated.report.challenge_ready, true);
  assert.deepEqual(generated.report.warnings, []);
  assert.equal(generated.scenario.ground_truth.length, 300);
  assert.equal(generated.scenario.observations.length + generated.scenario.missed_detections.length, 600);
  assert.equal(generated.report.successful_bearing_crossings, 300);
  assert.ok(generated.report.crossing_angle_deg.min > 35);
  assert.ok(generated.scenario.sensors.every((sensor) => sensor.antenna_hae_m > sensor.mast_m));
  assert.ok(generated.scenario.observations.every((observation) => observation.terrain_coverage === 1));
  // At 1.5 km above this low-relief DSM the route is clear; do not invent hills/dropouts.
  assert.equal(generated.scenario.missed_detections.length, 0);
  for (const receiver of generated.report.receivers) assert.equal(receiver.max_terrain_loss_db, 0);
  assert.ok(generated.cot.includes('time="2026-10-18T12:00:00.000Z"'));
  assert.equal((generated.cot.match(/<event version=/g) ?? []).length, 902);
  const cotIds = new Set(generated.cotAssociations.map((item) => item.record_id));
  assert.equal(cotIds.size, 902);
  for (const observation of generated.scenario.observations) assert.ok(cotIds.has(observation.id));
  assert.ok(generated.cotAssociations.every((item) => Date.parse(item.timestamp_utc) >= Date.parse(trajectory.start_utc)));
});

test("receiver placement is consequential: a 15 m baseline cannot provide stable crossing geometry", () => {
  const bad = structuredClone(config);
  bad.receivers[1].lat = bad.receivers[0].lat + 0.0001;
  bad.receivers[1].lon = bad.receivers[0].lon + 0.0001;
  bad.noise = { shadowingSigmaDb: 0, bearingNoiseScale: 0 };
  for (const receiver of bad.receivers) receiver.biasDeg = 0;
  const result = generateRfScenario(trajectory, bad, terrain.verified);
  assert.equal(result.report.successful_bearing_crossings, 0);
});
