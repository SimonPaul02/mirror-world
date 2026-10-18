import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { loadScenario } from '../engine/config.mjs';
import { readTerrain } from '../engine/terrain.mjs';
import { generateTrajectory } from '../engine/trajectory.mjs';

const scenario=await loadScenario();
const terrain=await readTerrain(scenario.elevationBytes,scenario.manifest);

test('UI worker matches CLI, responds to changed inputs, and recovers after rejection',async()=>{
  const worker=new Worker(new URL('./helpers/browser-worker.mjs',import.meta.url), {execArgv:['--conditions=browser']});
  try {
    await once(worker,'message');
    let id=0;
    async function run(input) {
      const response=once(worker,'message');
      worker.postMessage({id:++id,input,scenarioId:'ukraine_demo_001',assetsBase:'https://local.test/trajectory/'});
      const [result]=await response;
      assert.equal(result.id,id);
      return result;
    }
    const original=structuredClone(scenario.input);
    const first=await run(original);
    assert.deepEqual(first.output,generateTrajectory(original,terrain,scenario.manifest));
    assert.equal(first.receiverOutput.scenario_id,'ukraine_demo_001');
    assert.equal(first.receiverOutput.ground_truth.length,first.output.trajectory_truth.length);
    assert(first.receiverOutput.ground_truth[0].hae_m > first.output.trajectory_truth[0].altitude_egm2008_m);
    const changed=structuredClone(original); changed.simulation.seed=43;
    const second=await run(changed);
    assert.notDeepEqual(second.output.trajectory_truth,first.output.trajectory_truth);
    assert.deepEqual(second.output,generateTrajectory(changed,terrain,scenario.manifest));
    changed.simulation.duration_s=120; changed.initial_state.height_above_surface_m=2000;
    const shorter=await run(changed);
    assert.equal(shorter.output.trajectory_truth.length,120);
    assert.equal(shorter.output.validation.terminal_state.elapsed_s,120);
    assert.equal(shorter.output.trajectory_truth[0].height_above_surface_m,2000);
    const invalid=structuredClone(original); invalid.simulation.seed=-1;
    const invalidResult=await run(invalid);
    assert.match(invalidResult.error.message,/seed/); assert.equal(invalidResult.output,undefined);
    const outside=structuredClone(original); outside.initial_state.longitude_deg=terrain.bounds[2]-.000001;
    outside.simulation.duration_s=1;
    const outsideResult=await run(outside);
    assert.equal(outsideResult.error.code,'OUT_OF_BOUNDS'); assert(outsideResult.error.elapsed_s>0);
    assert.equal(outsideResult.output,undefined);
    assert.deepEqual((await run(original)).output,first.output);
    const other=structuredClone(original);other.object_id='drone_002';other.initial_state.longitude_deg+=.002;other.simulation.seed=43;
    const message=once(worker,'message');
    worker.postMessage({id:++id,inputs:[original,other],scenarioId:'multi',assetsBase:'https://local.test/trajectory/'});
    const [multi]=await message;
    assert.equal(multi.flights.length,2);
    assert.deepEqual(multi.flights[0].output,generateTrajectory(original,terrain,scenario.manifest));
    assert.deepEqual(multi.flights[1].output,generateTrajectory(other,terrain,scenario.manifest));
    assert.equal(multi.flights[1].receiverOutput.ground_truth[0].object_id,'drone_002');
  } finally { await worker.terminate(); }
});
