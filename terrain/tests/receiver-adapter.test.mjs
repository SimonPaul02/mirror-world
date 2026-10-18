import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { toReceiverGroundTruth } from '../engine/receiver-adapter.mjs';
import { loadScenario } from '../engine/config.mjs';
import { readTerrain } from '../engine/terrain.mjs';
import { generateTrajectory } from '../engine/trajectory.mjs';
const scenario=await loadScenario();
const terrain=await readTerrain(scenario.elevationBytes,scenario.manifest);
const truth=generateTrajectory(scenario.input,terrain,scenario.manifest);
const geoid=JSON.parse(await readFile(new URL('../odesa/geoid-egm2008.json',import.meta.url),'utf8'));

const plane={width:2,height:2,west:30,north:47,dx:1,dy:1,values:[20,30,40,50],
  band_metadata:{DESCRIPTION:'geoid_undulation',UNITTYPE:'metre'}};

test('receiver adapter uses exact field contract, elapsed time and additive interpolated geoid',()=>{
  const before=JSON.stringify(truth);
  const input=structuredClone(truth);
  // Center of the analytical grid has undulation (20+30+40+50)/4 = 35 m.
  Object.assign(input.trajectory_truth[0],{longitude_deg:30.5,latitude_deg:46.5,altitude_egm2008_m:1000});
  input.trajectory_truth=input.trajectory_truth.slice(0,1);
  const result=toReceiverGroundTruth(input,{scenarioId:'ukraine_demo_001',geoid:plane});
  assert.deepEqual(result,{scenario_id:'ukraine_demo_001',sample_period_s:1,ground_truth:[{
    timestamp_s:0,object_id:scenario.input.object_id,lat:46.5,lon:30.5,hae_m:1035
  }]});
  assert.equal(JSON.stringify(truth),before);
  assert.equal(input.trajectory_truth[0].altitude_egm2008_m,1000);
});

test('real export preserves object IDs, cadence, count and excludes terminal state',()=>{
  const input=structuredClone(scenario.input);
  input.object_id='D1'; input.simulation.output_interval_s=2;
  const generated=generateTrajectory(input,terrain,scenario.manifest);
  const result=toReceiverGroundTruth(generated,{scenarioId:'ukraine_demo_002',geoid});
  assert.equal(result.sample_period_s,2); assert.equal(result.ground_truth.length,150);
  assert.equal(result.ground_truth.at(-1).timestamp_s,298);
  result.ground_truth.forEach((s,i)=>{
    assert.equal(s.timestamp_s,i*2); assert.equal(s.object_id,'D1');
    assert.equal(s.lon,generated.trajectory_truth[i].longitude_deg);
    assert.equal(s.lat,generated.trajectory_truth[i].latitude_deg);
    const difference=s.hae_m-generated.trajectory_truth[i].altitude_egm2008_m;
    assert(difference>26 && difference<29);
  });
});

test('adapter rejects missing ID, wrong datum, irregular samples, nonfinite heights and missing geoid coverage',()=>{
  assert.throws(()=>toReceiverGroundTruth(truth,{scenarioId:' ',geoid}),/scenario_id/);
  for(const mutate of [
    o=>{o.coordinates.vertical_crs='EPSG:4979';},
    o=>{o.trajectory_truth[1].elapsed_s=1.5;},
    o=>{o.trajectory_truth[1].timestamp='2026-10-18T12:05:00Z';},
    o=>{o.trajectory_truth[0].altitude_egm2008_m=NaN;},
    o=>{o.trajectory_truth[0].latitude_deg=0;},
    o=>{o.validation.status='failed';}
  ]) {
    const changed=structuredClone(truth);mutate(changed);
    assert.throws(()=>toReceiverGroundTruth(changed,{scenarioId:'test',geoid}));
  }
});

test('receiver CLI matches adapter and preserves existing output on rejection',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'mirror-receiver-'));
  try {
    const inputPath=path.join(dir,'trajectory.json'), outputPath=path.join(dir,'ground_truth.json');
    const cli=fileURLToPath(new URL('../export-receiver.mjs',import.meta.url));
    await writeFile(inputPath,JSON.stringify(truth));
    const invoke=()=>spawnSync(process.execPath,[cli,inputPath,'ukraine_demo_001',outputPath],{encoding:'utf8'});
    const success=invoke(); assert.equal(success.status,0,success.stderr);
    const bytes=await readFile(outputPath,'utf8');
    assert.deepEqual(JSON.parse(bytes),toReceiverGroundTruth(truth,{scenarioId:'ukraine_demo_001',geoid}));
    const invalid=structuredClone(truth);invalid.coordinates.vertical_crs='EPSG:4979';
    await writeFile(inputPath,JSON.stringify(invalid));
    const failure=invoke(); assert.equal(failure.status,1);
    assert.equal(JSON.parse(failure.stderr).output_written,false);
    assert.equal(await readFile(outputPath,'utf8'),bytes);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
