import { Cartesian3, Cartographic, EllipsoidGeodesic, Matrix4, Transforms } from "cesium";

export interface LocalOrigin { lat: number; lon: number }

/** A documented synthetic heightfield, not actual Ukrainian elevation. */
export interface SyntheticTerrain {
  kind: "synthetic";
  base_hae_m: number;
  ridge?: { x_m: number; y_m: number; sigma_x_m: number; sigma_y_m: number; height_m: number };
}

/** Grid rows run south to north, columns west to east. Heights are ellipsoidal. */
export interface TerrainGrid {
  kind: "grid";
  source: string;
  real_terrain: boolean;
  height_reference: "ellipsoid";
  south_lat: number;
  west_lon: number;
  step_lat_deg: number;
  step_lon_deg: number;
  heights_hae_m: number[][];
}

/** The raster lives outside the JSON config; a verified sampler is injected. */
export interface ReferencedTerrain {
  kind: "manifest";
  manifest_path: string;
  source: string;
  height_reference: "ellipsoid";
}

export type SensorTerrain = SyntheticTerrain | TerrainGrid | ReferencedTerrain;

/** Express a receiver's local true-north azimuth in the shared origin ENU frame. */
export function bearingInOriginFrame(origin: LocalOrigin, receiver: LocalOrigin, bearingDeg: number): number {
  const reference = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(origin.lon, origin.lat));
  const sensor = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(receiver.lon, receiver.lat));
  const radians = bearingDeg * Math.PI / 180;
  const world = Matrix4.multiplyByPointAsVector(sensor, new Cartesian3(Math.sin(radians), Math.cos(radians), 0), new Cartesian3());
  const local = Matrix4.multiplyByPointAsVector(Matrix4.inverseTransformation(reference, new Matrix4()), world, new Cartesian3());
  return (Math.atan2(local.x, local.y) * 180 / Math.PI + 360) % 360;
}

export function toLocalXY(origin: LocalOrigin, point: Cartographic): [number, number] {
  const start = Cartographic.fromDegrees(origin.lon, origin.lat);
  if (Math.abs(start.latitude - point.latitude) + Math.abs(start.longitude - point.longitude) < 1e-12) return [0, 0];
  const geodesic = new EllipsoidGeodesic(start, point);
  return [geodesic.surfaceDistance * Math.sin(geodesic.startHeading), geodesic.surfaceDistance * Math.cos(geodesic.startHeading)];
}

export function fromLocalXY(origin: LocalOrigin, x: number, y: number, haeM = 0): Cartographic {
  const frame = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(origin.lon, origin.lat));
  const point = Cartographic.fromCartesian(Matrix4.multiplyByPoint(frame, new Cartesian3(x, y, 0), new Cartesian3()));
  point.height = haeM;
  return point;
}

export function makeSensorTerrainSampler(terrain: SensorTerrain, origin: LocalOrigin): (point: Cartographic) => number | undefined {
  if (terrain.kind === "manifest") throw new Error("A manifest terrain needs the verified elevation/geoid sampler");
  if (terrain.kind === "synthetic") {
    if (!Number.isFinite(terrain.base_hae_m)) throw new Error("Invalid synthetic terrain height");
    const ridge = terrain.ridge;
    if (ridge && (!Object.values(ridge).every(Number.isFinite) || ridge.sigma_x_m <= 0 || ridge.sigma_y_m <= 0 || ridge.height_m < 0)) throw new Error("Invalid synthetic ridge");
    return (point) => {
      if (!ridge) return terrain.base_hae_m;
      const [x, y] = toLocalXY(origin, point);
      return terrain.base_hae_m + ridge.height_m * Math.exp(-0.5 * (((x - ridge.x_m) / ridge.sigma_x_m) ** 2 + ((y - ridge.y_m) / ridge.sigma_y_m) ** 2));
    };
  }
  if (terrain.kind !== "grid" || terrain.height_reference !== "ellipsoid") throw new Error("Terrain grid must supply ellipsoidal heights");
  const rows = terrain.heights_hae_m;
  const columns = rows[0]?.length ?? 0;
  if (rows.length < 2 || columns < 2 || rows.some((row) => row.length !== columns || !row.every(Number.isFinite))) throw new Error("Terrain grid must be rectangular with finite heights");
  if (![terrain.south_lat, terrain.west_lon, terrain.step_lat_deg, terrain.step_lon_deg].every(Number.isFinite) || terrain.step_lat_deg <= 0 || terrain.step_lon_deg <= 0) throw new Error("Invalid terrain grid extent");
  return (point) => {
    const x = (point.longitude * 180 / Math.PI - terrain.west_lon) / terrain.step_lon_deg;
    const y = (point.latitude * 180 / Math.PI - terrain.south_lat) / terrain.step_lat_deg;
    if (x < 0 || y < 0 || x > columns - 1 || y > rows.length - 1) return undefined;
    const column = Math.min(Math.floor(x), columns - 2);
    const row = Math.min(Math.floor(y), rows.length - 2);
    const fx = x - column;
    const fy = y - row;
    const a = rows[row] as number[];
    const b = rows[row + 1] as number[];
    return (1 - fy) * ((a[column] as number) * (1 - fx) + (a[column + 1] as number) * fx)
      + fy * ((b[column] as number) * (1 - fx) + (b[column + 1] as number) * fx);
  };
}
