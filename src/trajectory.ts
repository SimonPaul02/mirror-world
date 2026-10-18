/** Arda's sampled flight truth, independent of receiver observations. */
export interface DroneTrajectory {
  scenario_id: string;
  start_utc: string;
  coordinate_frame: "wgs84";
  height_reference: "ellipsoid";
  duration_s: number;
  sample_period_s: number;
  ground_truth: Array<{
    timestamp_s: number;
    object_id: string;
    lat: number;
    lon: number;
    hae_m: number;
    agl_m?: number;
  }>;
}

export function parseTrajectory(input: unknown): DroneTrajectory {
  if (!input || typeof input !== "object") throw new Error("Trajectory must be a JSON object");
  const data = input as Record<string, unknown>;
  if (typeof data.scenario_id !== "string" || !data.scenario_id.trim()) throw new Error("A scenario_id is required");
  if (data.coordinate_frame !== undefined && data.coordinate_frame !== "wgs84") throw new Error("Trajectory requires WGS84 latitude/longitude degrees");
  if (data.height_reference !== undefined && data.height_reference !== "ellipsoid") throw new Error("hae_m must be height above the WGS84 ellipsoid");
  if (typeof data.sample_period_s !== "number" || !Number.isFinite(data.sample_period_s) || data.sample_period_s <= 0) throw new Error("sample_period_s must be positive");
  if (!Array.isArray(data.ground_truth) || data.ground_truth.length < 2) throw new Error("At least two timestamped truth samples are required");
  let previous = -1;
  let objectId: string | undefined;
  const ground_truth: DroneTrajectory["ground_truth"] = data.ground_truth.map((raw: unknown) => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid truth sample");
    const point = raw as Record<string, unknown>;
    for (const key of ["timestamp_s", "lat", "lon", "hae_m"] as const) {
      if (typeof point[key] !== "number" || !Number.isFinite(point[key])) throw new Error(`Truth sample requires finite ${key}`);
    }
    const timestamp_s = point.timestamp_s as number;
    const lat = point.lat as number;
    const lon = point.lon as number;
    if (timestamp_s < 0 || timestamp_s <= previous) throw new Error("Trajectory timestamps must be nonnegative and strictly increasing");
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error("Invalid latitude/longitude degrees");
    if (typeof point.object_id !== "string" || !point.object_id.trim()) throw new Error("Every truth sample needs object_id");
    objectId ??= point.object_id;
    if (point.object_id !== objectId) throw new Error("The sensor MVP supports exactly one drone");
    if (point.agl_m !== undefined && (typeof point.agl_m !== "number" || !Number.isFinite(point.agl_m) || point.agl_m < 0)) throw new Error("agl_m must be nonnegative if supplied");
    previous = timestamp_s;
    return { timestamp_s, object_id: point.object_id, lat, lon, hae_m: point.hae_m as number, ...(point.agl_m === undefined ? {} : { agl_m: point.agl_m as number }) };
  });
  const duration_s = data.duration_s === undefined ? previous + data.sample_period_s : data.duration_s;
  if (typeof duration_s !== "number" || !Number.isFinite(duration_s) || duration_s <= previous) throw new Error("duration_s must extend past the last sample");
  const start_utc = data.start_utc ?? "2026-11-03T12:10:00Z";
  if (typeof start_utc !== "string" || !Number.isFinite(Date.parse(start_utc))) throw new Error("Invalid start_utc");
  return { scenario_id: data.scenario_id, start_utc, coordinate_frame: "wgs84", height_reference: "ellipsoid", duration_s, sample_period_s: data.sample_period_s, ground_truth };
}
