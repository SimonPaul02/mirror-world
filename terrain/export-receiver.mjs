import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './engine/config.mjs';
import { toReceiverGroundTruth } from './engine/receiver-adapter.mjs';

const defaultInput = fileURLToPath(new URL('./generated/trajectory_truth.json', import.meta.url));
const defaultOutput = fileURLToPath(new URL('./generated/ground_truth.json', import.meta.url));
const manifestPath = fileURLToPath(new URL('./odesa/manifest.json', import.meta.url));
let temporaryPath;
try {
  if (process.argv.length > 5) throw new Error('Usage: node terrain/export-receiver.mjs [trajectory.json] [scenario_id] [output.json]');
  const inputPath = path.resolve(process.argv[2] ?? defaultInput);
  const scenarioId = process.argv[3] ?? 'ukraine_demo_001';
  const outputPath = path.resolve(process.argv[4] ?? defaultOutput);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const asset = manifest.assets.geoid_undulation;
  const geoidPath = path.resolve(path.dirname(manifestPath), asset.path);
  const protectedPaths = [inputPath, manifestPath,
    ...Object.values(manifest.assets).map(a => path.resolve(path.dirname(manifestPath), a.path))];
  if (protectedPaths.includes(outputPath)) throw new Error('Output path overlaps input or terrain assets');
  const bytes = await readFile(geoidPath);
  if (bytes.length !== asset.size_bytes || sha256(bytes) !== asset.sha256) throw new Error('Geoid checksum mismatch');
  const truth = JSON.parse(await readFile(inputPath, 'utf8'));
  const output = toReceiverGroundTruth(truth, { scenarioId, geoid: JSON.parse(bytes.toString('utf8')) });
  await mkdir(path.dirname(outputPath), { recursive: true });
  temporaryPath = `${outputPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' });
  await rename(temporaryPath, outputPath); temporaryPath = undefined;
  console.log(JSON.stringify({ status: 'pass', output: outputPath, scenario_id: output.scenario_id,
    samples: output.ground_truth.length, sample_period_s: output.sample_period_s }, null, 2));
} catch (error) {
  if (temporaryPath) await rm(temporaryPath, { force: true });
  console.error(JSON.stringify({ status: 'failed', message: error.message, output_written: false }));
  process.exitCode = 1;
}
