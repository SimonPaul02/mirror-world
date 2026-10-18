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
    validateConfig(data.input, manifest);
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    const [manifestHash, inputHash] = await Promise.all([sha256(encode(manifest)), sha256(encode(data.input))]);
    const output = generateTrajectoryCore(data.input, terrain, manifest, {manifest: manifestHash, input: inputHash});
    const receiverOutput = toReceiverGroundTruth(output, { scenarioId: data.scenarioId, geoid });
    self.postMessage({ id: data.id, output, receiverOutput });
  } catch (error) {
    const failure = error as Error & { code?: string; details?: { elapsed_s?: number } };
    self.postMessage({ id: data.id, error: { message: failure.message, code: failure.code,
      elapsed_s: failure.details?.elapsed_s } });
  }
};
