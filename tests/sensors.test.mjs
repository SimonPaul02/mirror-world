import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Cartographic, EllipsoidGeodesic } from "cesium";

import { mulberry32, toDeg } from "../src/math.ts";
import { generateRfScenario } from "../src/sensor-generator.ts";
import { fromLocalXY, makeSensorTerrainSampler } from "../src/sensor-terrain.ts";
import { ScenarioCapture, validateScenario } from "../src/scenario-data.ts";
import { crossBearings, fsplDb, knifeEdgeLossDb, SignalModel } from "../src/signals.ts";
import { parseTrajectory } from "../src/trajectory.ts";

const load = (name) => JSON.parse(readFileSync(new URL(`../examples/${name}`, import.meta.url), "utf8"));
const trajectory = load("drone_trajectory_mock_60s.json");
const config = load("rf_sensor_config.json");

function model(settings = config, terrainOverride) {
  const receivers = settings.receivers.map((rx) => {
    const point = fromLocalXY(settings.origin, rx.x_m, rx.y_m);
    return { ...rx, lat: toDeg(point.latitude), lon: toDeg(point.longitude) };
  });
  const emitter = { ...settings.emitter, uid: "D1" };
  const terrain = terrainOverride ?? makeSensorTerrainSampler(settings.terrain, settings.origin);
  return {
    receivers, emitter,
    signals: new SignalModel(receivers, emitter, terrain, mulberry32(42), { samplePeriodS: 1, shadowingSigmaDb: 0, bearingNoiseScale: 0 }),
  };
}

test("free-space reference and distance/frequency doubling give 6.02 dB", () => {
  assert.ok(Math.abs(fsplDb(1000, 2400) - 100.0442) < 0.001);
  assert.ok(Math.abs(fsplDb(2000, 2400) - fsplDb(1000, 2400) - 6.0206) < 0.0001);
  assert.ok(Math.abs(fsplDb(1000, 4800) - fsplDb(1000, 2400) - 6.0206) < 0.0001);
  assert.throws(() => fsplDb(1000, 0), /frequency/);
});

test("knife-edge loss rises from a clear Fresnel path to an obstruction", () => {
  assert.equal(knifeEdgeLossDb(-1), 0);
  assert.ok(Math.abs(knifeEdgeLossDb(0) - 6.03) < 0.01);
  assert.ok(knifeEdgeLossDb(2) > knifeEdgeLossDb(1));
});

test("receiver power follows the link budget and increased transmit power", () => {
  const settings = structuredClone(config);
  delete settings.terrain.ridge;
  const target = fromLocalXY(settings.origin, 0, 2500, 300);
  const base = model(settings).signals.observe(target)[0];
  assert.ok(Math.abs(base.rssiDbm - (settings.emitter.eirpDbm + settings.receivers[0].gainDbi - base.fsplDb - base.terrainLossDb)) < 1e-9);
  settings.emitter.eirpDbm += 10;
  const stronger = model(settings).signals.observe(target)[0];
  assert.ok(Math.abs(stronger.rssiDbm - base.rssiDbm - 10) < 1e-9);
});

test("the same ridge blocks RF2, leaves RF1 clear, and clears at higher altitude", () => {
  const flat = structuredClone(config);
  delete flat.terrain.ridge;
  const target = fromLocalXY(config.origin, 0, 2650, 300);
  const clear = model(flat).signals.observe(target);
  const blocked = model().signals.observe(target);
  assert.ok(clear.every((reading) => reading.heard));
  assert.equal(blocked[0].heard, true);
  assert.equal(blocked[1].heard, false);
  assert.ok(blocked[1].terrainLossDb > 20);
  assert.ok(clear[1].rssiDbm - blocked[1].rssiDbm > 20);
  target.height = 1000;
  assert.ok(model().signals.observe(target).every((reading) => reading.heard));
});

test("perfect measured bearings cross near truth without hidden drone fields", () => {
  const flat = structuredClone(config);
  delete flat.terrain.ridge;
  for (const rx of flat.receivers) rx.biasDeg = 0;
  const target = fromLocalXY(config.origin, 0, 2500, 300);
  const readings = model(flat).signals.observe(target);
  const fix = crossBearings(readings);
  assert.ok(fix);
  const miss = new EllipsoidGeodesic(target, Cartographic.fromDegrees(fix.lon, fix.lat)).surfaceDistance;
  assert.ok(miss < 2, `perfect crossing error ${miss} m`);
  const changedTruth = structuredClone(readings);
  for (const reading of changedTruth) {
    reading.trueBearingDeg = 180;
    reading.trueElevationDeg = 89;
    reading.groundRangeM = 1e9;
    reading.slantRangeM = 1;
  }
  assert.deepEqual(crossBearings(changedTruth), fix);
});

test("crossing rejects missing, duplicate, parallel, backward and nonfinite reports", () => {
  const readings = model().signals.observe(fromLocalXY(config.origin, -900, 2500, 300));
  assert.ok(readings.every((reading) => reading.heard));
  assert.equal(crossBearings([readings[0]]), undefined);
  assert.equal(crossBearings([readings[0], readings[0]]), undefined);
  const withAngles = (a, b) => readings.map((reading, index) => ({ ...reading, measuredBearingDeg: index ? b : a }));
  assert.equal(crossBearings(withAngles(0, 0)), undefined);
  assert.equal(crossBearings(withAngles(0, 180)), undefined);
  assert.equal(crossBearings(withAngles(315, 45)), undefined);
  assert.equal(crossBearings(withAngles(NaN, 315)), undefined);
});

test("unknown terrain never yields a valid detection or fabricated power record", () => {
  const { receivers, emitter, signals } = model(config, () => undefined);
  const drone = fromLocalXY(config.origin, 0, 2500, 300);
  const readings = signals.observe(drone);
  assert.ok(readings.every((reading) => !reading.heard && !reading.terrainComplete));
  const capture = new ScenarioCapture({scenarioId: "unknown", startUtc: trajectory.start_utc, seed: 1, requestedDurationS: 1, samplePeriodS: 1, route: [], emitter, receivers, realTerrainAvailable: true, terrainSource: "unavailable"});
  capture.record({timestampS: 0, drone, aglM: 200, detections: readings});
  assert.equal(capture.snapshot().observations.length, 0);
  assert.ok(capture.snapshot().missed_detections.every((record) => record.reason === "terrain_unavailable" && record.power_dbm === null));
});

test("trajectory importer validates clock, one object and altitude convention", () => {
  assert.equal(parseTrajectory(trajectory).ground_truth.length, 60);
  assert.throws(() => parseTrajectory({ ...trajectory, height_reference: "agl" }), /ellipsoid/);
  const duplicate = structuredClone(trajectory);
  duplicate.ground_truth[1].timestamp_s = 0;
  assert.throws(() => parseTrajectory(duplicate), /increasing/);
  const otherObject = structuredClone(trajectory);
  otherObject.ground_truth[1].object_id = "D2";
  assert.throws(() => parseTrajectory(otherObject), /one drone/);
});

test("headless generator exports synchronized records and complete answer keys reproducibly", () => {
  const generated = generateRfScenario(trajectory, config);
  const { scenario, report } = generated;
  assert.deepEqual(generated, generateRfScenario(trajectory, config));
  assert.equal(scenario.duration_s, 60);
  assert.equal(scenario.ground_truth.length, 60);
  assert.deepEqual(scenario.sample_times_s, Array.from({length: 60}, (_, index) => index));
  assert.equal(scenario.observations.length + scenario.missed_detections.length, 120);
  assert.equal(scenario.observations.length, scenario.associations.length);
  assert.equal(scenario.missed_detections.length, scenario.missed_detection_associations.length);
  assert.ok(scenario.missed_detections.some((record) => record.sensor_id === "RF2"));
  assert.ok(scenario.observations.every((record) => record.bearing_deg >= 0 && record.bearing_deg < 360 && record.frequency_mhz === config.emitter.freqMhz && !("object_id" in record) && !("trueBearingDeg" in record)));
  assert.deepEqual(validateScenario(scenario, {allowSyntheticTerrain: true, minDurationS: 0}), []);
  assert.equal(report.challenge_ready, false);
  assert.equal(report.warnings.length, 2); // Deliberately one minute and synthetic terrain.
  const differentSeed = generateRfScenario(trajectory, { ...config, seed: config.seed + 1 });
  assert.deepEqual(differentSeed.scenario.ground_truth, scenario.ground_truth);
  assert.notDeepEqual(differentSeed.scenario.observations, scenario.observations);
});

test("grid interpolation and missing coverage are explicit", () => {
  const grid = {kind: "grid", source: "test only", real_terrain: false, height_reference: "ellipsoid", south_lat: 49, west_lon: 31, step_lat_deg: 0.01, step_lon_deg: 0.01, heights_hae_m: [[0, 10], [20, 30]]};
  const sample = makeSensorTerrainSampler(grid, config.origin);
  assert.ok(Math.abs(sample(Cartographic.fromDegrees(31.005, 49.005)) - 15) < 1e-8);
  assert.equal(sample(Cartographic.fromDegrees(32, 50)), undefined);
  assert.throws(() => generateRfScenario(trajectory, { ...config, terrain: grid }), /terrain coverage/);
  const underground = structuredClone(trajectory);
  underground.ground_truth[0].hae_m = 50;
  assert.throws(() => generateRfScenario(underground, config), /intersects terrain/);
});
