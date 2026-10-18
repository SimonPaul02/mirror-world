import { toReceiverGroundTruth } from '../terrain/engine/receiver-adapter.mjs';
import { validateConfig } from '../terrain/engine/validation.mjs';
import { readTerrain } from '../terrain/engine/terrain.mjs';
import { generateTrajectoryCore } from '../terrain/engine/trajectory-core.mjs';

async function sha256(bytes: Uint8Array<ArrayBuffer>) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
async function load(base: string) {
  const fetchAsset = async (name: string) => {
    const response = await fetch(base + name);
    if (!response.ok) throw new Error(`Could not load ${name}: ${response.status}`);
    return response;
  };
  const manifest = await (await fetchAsset('manifest.json')).json();
  const bytes = new Uint8Array(await (await fetchAsset('elevation.tif')).arrayBuffer());
  if (await sha256(bytes) !== manifest.assets.surface_elevation.sha256) throw new Error('Elevation checksum mismatch');
  const geoidBytes = new Uint8Array(await (await fetchAsset('geoid-egm2008.json')).arrayBuffer());
  if (await sha256(geoidBytes) !== manifest.assets.geoid_undulation.sha256) throw new Error('Geoid checksum mismatch');
  const geoid = JSON.parse(new TextDecoder().decode(geoidBytes));
  return { manifest, terrain: await readTerrain(bytes, manifest), geoid };
}
let loaded: ReturnType<typeof load> | undefined;
self.onmessage = async ({ data }) => {
  try {
    loaded ??= load(data.assetsBase).catch(error => { loaded = undefined; throw error; });
    const { manifest, terrain, geoid } = await loaded;
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    const inputs=data.inputs??[data.input];
    if(!Array.isArray(inputs)||inputs.length<1||inputs.length>5) throw new Error('Choose 1–5 drones');
    if(new Set(inputs.map(input=>input.object_id)).size!==inputs.length) throw new Error('Drone object IDs must be distinct');
    const manifestHash=await sha256(encode(manifest));
    const flights=[];
    for(const [index,input] of inputs.entries()) {
      validateConfig(input, manifest);
      if(input.simulation.start_time!==inputs[0].simulation.start_time || input.simulation.duration_s!==inputs[0].simulation.duration_s || input.simulation.output_interval_s!==inputs[0].simulation.output_interval_s) throw new Error('All drones must share the scenario clock');
      const inputHash=await sha256(encode(input));
      const output = generateTrajectoryCore(input, terrain, manifest, {manifest: manifestHash, input: inputHash});
      const receiverOutput = toReceiverGroundTruth(output, { scenarioId: index===0?data.scenarioId:`${data.scenarioId}__drone${index+1}`, geoid });
      flights.push({output,receiverOutput});
    }
    self.postMessage({ id: data.id, ...flights[0], flights });
  } catch (error) {
    const failure = error as Error & { code?: string; details?: { elapsed_s?: number } };
    self.postMessage({ id: data.id, error: { message: failure.message, code: failure.code,
      elapsed_s: failure.details?.elapsed_s } });
  }
};
