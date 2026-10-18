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
import { randomReceiverSites } from '../src/scenario-config.ts';
import { generateOptionalSensors } from '../src/optional-sensors.ts';

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
  // The high default route clears this low-relief DSM; do not invent hills/dropouts.
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

test('zero and one RF receivers preserve the clock without fabricating position fixes',()=>{
  for(const count of [0,1]) {
    const result=generateRfScenario(trajectory,{...config,receivers:config.receivers.slice(0,count)},terrain.verified);
    assert.equal(result.scenario.ground_truth.length,300);
    assert.equal(result.scenario.observations.length,count*300);
    assert.equal(result.fixes.length,0);
    assert.equal(result.scenario.associations.length,count*300);
  }
});

test('five seeded receivers stay in the original crop and supply valid measured pairs',()=>{
  const bounds=source.manifest.grid.sample_center_bounds_wsen;
  const sites=randomReceiverSites(config.receivers[0],5,42,bounds,terrain.verified.sample);
  assert.deepEqual(sites,randomReceiverSites(config.receivers[0],5,42,bounds,terrain.verified.sample));
  assert.notDeepEqual(sites,randomReceiverSites(config.receivers[0],5,43,bounds,terrain.verified.sample));
  for(const site of sites) {assert(site.lon>=bounds[0]&&site.lon<=bounds[2]);assert(site.lat>=bounds[1]&&site.lat<=bounds[3]);}
  const result=generateRfScenario(trajectory,{...config,receivers:sites},terrain.verified);
  assert.equal(result.scenario.observations.length+result.scenario.missed_detections.length,1500);
  assert(result.fixes.length>0);
  const observations=new Set(result.scenario.observations.map(observation=>observation.id));
  for(const fix of result.fixes) {assert.equal(fix.observation_ids_used.length,2);assert(fix.observation_ids_used.every(id=>observations.has(id)));}
});

test('onboard camera follows its host, excludes self, respects occlusion, and keeps image answer keys separate',()=>{
  const make=(objectId,offset)=>({objectId,trajectory:{scenario_id:'camera_test',start_utc:'2026-10-18T12:00:00Z',sample_period_s:1,duration_s:2,ground_truth:[0,1].map(timestamp_s=>({timestamp_s,object_id:objectId,lon:30.65,lat:46.5+offset+timestamp_s*.0001,hae_m:200}))},states:[{heading_deg:0},{heading_deg:0}]});
  const flights=[make('host',0),make('target',.001)];
  const camera={id:'CAM1',platform:'drone',host_object_id:'host',lat:46.5,lon:30.65,height_agl_m:12,heading_deg:0,pitch_deg:0,horizontal_fov_deg:20,width_px:1920,height_px:1080};
  const context={data_uri:'data:image/png;base64,AA',bounds:[30.55,46.3,30.95,46.7],attribution:'test',source_id:'terrain'};
  const options={cameras:[camera],satellite_count:1,interval_s:1};
  const result=generateOptionalSensors(options,flights,()=>0,context);
  assert.equal(result.camera_frames.length,2);assert.equal(result.camera_frames[0].detections.length,1);
  assert.equal(result.camera_frames[1].camera_pose.lat,flights[0].trajectory.ground_truth[1].lat);
  assert(result.associations.some(item=>item.record_id===result.camera_frames[0].detections[0].id&&item.source_object_ids[0]==='target'));
  assert(!result.associations.some(item=>item.source_object_ids.includes('host')));
  assert.equal(result.satellite_images.length,2);assert.equal(result.satellite_images[0].timestamp_utc,'2026-10-18T12:00:00.000Z');
  assert.deepEqual(result.satellite_images[0].objects_detected,[]);assert.equal(result.satellite_images[0].optical_acquisition_time,null);
  const blocked=generateOptionalSensors(options,flights,point=>point.latitude*180/Math.PI>46.5003&&point.latitude*180/Math.PI<46.5008?500:0,context);
  assert(blocked.camera_frames.every(frame=>frame.detections.length===0));
  const disabled=generateOptionalSensors({cameras:[],satellite_count:0,interval_s:1},flights,()=>0,context);
  assert.deepEqual(disabled.camera_frames,[]);assert.deepEqual(disabled.satellite_images,[]);assert.deepEqual(disabled.assets,{});
});
