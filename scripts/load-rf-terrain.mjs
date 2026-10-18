import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { readTerrain, createSampler } from "../terrain/engine/terrain.mjs";

/** Load and verify the team's actual DSM and its matching geoid, without resampling. */
export async function loadRfTerrain(manifestPath) {
  const absolute = resolve(manifestPath);
  const manifest = JSON.parse(await readFile(absolute, "utf8"));
  if (manifest.coordinates.vertical_crs !== "EPSG:3855") throw new Error("Expected the team's EGM2008 DSM");
  const load = async (role) => {
    const asset = manifest.assets[role];
    const bytes = await readFile(resolve(dirname(absolute), asset.path));
    if (bytes.length !== asset.size_bytes || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw new Error(`${role} checksum mismatch`);
    return bytes;
  };
  const [elevationBytes, geoidBytes] = await Promise.all([load("surface_elevation"), load("geoid_undulation")]);
  const surface = await readTerrain(elevationBytes, manifest);
  const geoidGrid = JSON.parse(geoidBytes.toString("utf8"));
  if (geoidGrid.band_metadata?.DESCRIPTION !== "geoid_undulation" || geoidGrid.band_metadata?.UNITTYPE !== "metre") throw new Error("Invalid geoid metadata");
  const geoid = createSampler(geoidGrid);
  return {
    manifest,
    geoidGrid,
    surface,
    verified: {
      source: `${manifest.name}; DSM + EGM2008 geoid converted to WGS84 ellipsoidal heights`,
      real: true,
      provenance: { terrain_id: manifest.terrain_id, manifest_path: manifestPath, elevation_sha256: manifest.assets.surface_elevation.sha256, geoid_sha256: manifest.assets.geoid_undulation.sha256, height_conversion: "hae_m = altitude_egm2008_m + geoid_undulation_m", surface_type: manifest.dataset.surface_type, attribution: manifest.attribution },
      sample: (point) => {
        const lon = point.longitude * 180 / Math.PI;
        const lat = point.latitude * 180 / Math.PI;
        try { return surface.sample(lon, lat) + geoid.sample(lon, lat); }
        catch (error) { if (error.code === "OUT_OF_BOUNDS" || error.code === "MISSING_ELEVATION") return undefined; throw error; }
      },
    },
  };
}
