import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_INPUT = fileURLToPath(new URL("../inputs/odesa.example.json", import.meta.url));
export { TICK_MS, validateConfig } from "./validation.mjs";
import { validateConfig } from "./validation.mjs";
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
export async function loadScenario(inputFile = DEFAULT_INPUT) {
  const inputPath = path.resolve(inputFile);
  const input = await readJson(inputPath);
  assert(typeof input.terrain_manifest === "string", "terrain_manifest is required");
  const manifestPath = path.resolve(path.dirname(inputPath), input.terrain_manifest);
  const manifest = await readJson(manifestPath);
  validateConfig(input, manifest);
  let elevationBytes;
  for (const [role, asset] of Object.entries(manifest.assets)) {
    const bytes = await readFile(path.resolve(path.dirname(manifestPath), asset.path));
    assert.equal(bytes.length, asset.size_bytes, `${asset.path}: size mismatch`);
    assert.equal(sha256(bytes), asset.sha256,
      `${asset.path}: checksum mismatch; inspect changed raster before updating metadata`);
    if (role === "surface_elevation") elevationBytes = bytes;
  }
  assert(elevationBytes, "Manifest must supply a surface_elevation asset");
  return { input, manifest, elevationBytes, inputPath, manifestPath };
}
