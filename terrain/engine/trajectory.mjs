import { sha256 } from "./config.mjs";
import { generateTrajectoryCore } from "./trajectory-core.mjs";
export { ENGINE_VERSION, EARTH_RADIUS_M, advance } from "./trajectory-core.mjs";

export function generateTrajectory(input, terrain, manifest) {
  return generateTrajectoryCore(input, terrain, manifest, {
    manifest: sha256(JSON.stringify(manifest)), input: sha256(JSON.stringify(input))
  });
}
