import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fromArrayBuffer } from 'geotiff';
import { sampleGrid, replayState } from '../../src/replay-math.ts';
import { loadScenario } from '../engine/config.mjs';
import { readTerrain } from '../engine/terrain.mjs';
import { generateTrajectory } from '../engine/trajectory.mjs';

const scenario = await loadScenario();
const terrain = await readTerrain(scenario.elevationBytes, scenario.manifest);
const bytes = scenario.elevationBytes;
const image = await (await fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength))).getImage();
const surface = {width:image.getWidth(),height:image.getHeight(),west:image.getOrigin()[0],north:image.getOrigin()[1],
  dx:image.getResolution()[0],dy:-image.getResolution()[1],values:await image.readRasters({samples:[0],interleave:true})};
const geoid = JSON.parse(await readFile(new URL('../odesa/geoid-egm2008.json',import.meta.url),'utf8'));
const output = generateTrajectory(scenario.input,terrain,scenario.manifest);
const states = [...output.trajectory_truth,output.validation.terminal_state];

test('browser surface and geoid alignment preserve engine clearance throughout replay',()=>{
  for(const state of states) {
    const {longitude_deg:lon,latitude_deg:lat}=state;
    const ground=sampleGrid(surface,lon,lat);
    assert(Math.abs(ground-state.surface_elevation_egm2008_m)<1e-8);
    const n=sampleGrid(geoid,lon,lat);
    assert(n>26 && n<29, 'local EGM2008 undulation sign and range');
    assert(Math.abs((state.altitude_egm2008_m+n)-(ground+n)-state.height_above_surface_m)<1e-8);
  }
  for(const [lon,lat] of [[surface.west,surface.north],[surface.west+(surface.width-1)*surface.dx,surface.north-(surface.height-1)*surface.dy]])
    assert(Number.isFinite(sampleGrid(geoid,lon,lat)), 'geoid covers the entire DEM');
  assert.throws(()=>sampleGrid(surface,0,0),/outside/);
});

test('replay honors terminal state and interpolates heading across north',()=>{
  assert.deepEqual(replayState(states,-1),states[0]);
  assert.deepEqual(replayState(states,300),output.validation.terminal_state);
  assert.deepEqual(replayState(states,301),output.validation.terminal_state);
  const pair=[{...states[0],heading_deg:359},{...states[1],heading_deg:1}];
  const midpoint=replayState(pair,.5);
  assert.equal(midpoint.heading_deg,0);
  assert.equal(midpoint.elapsed_s,.5);
  assert.equal(midpoint.timestamp,'2026-10-18T12:00:00.500Z');
  assert.equal(midpoint.longitude_deg,(pair[0].longitude_deg+pair[1].longitude_deg)/2);
  assert.equal(pair[0].heading_deg,359);
});
