import { Cartographic, EllipsoidGeodesic, Math as CesiumMath } from "cesium";

import type { Emitter, ReceiverSite, Waypoint } from "./scenario";
import type { Detection } from "./signals";
import { bearingInOriginFrame } from "./sensor-terrain";

export interface RfObservation {
  id: string;
  timestamp_s: number;
  sensor_id: string;
  bearing_deg: number;
  sensor_bearing_deg: number;
  frequency_mhz: number;
  power_dbm: number;
  snr_db: number;
  bearing_sigma_deg: number;
  terrain_loss_db: number;
  terrain_coverage: number;
}

interface TruthPoint {
  timestamp_s: number;
  object_id: string;
  x_m: number;
  y_m: number;
  lat: number;
  lon: number;
  hae_m: number;
  agl_m: number;
}

export interface ScenarioData {
  schema_version: 1;
  scenario_id: string;
  configuration: {
    start_utc: string;
    seed: number;
    route: Waypoint[];
    emitter: Emitter;
    requested_duration_s: number;
    metadata?: Record<string, unknown>;
  };
  world_frame: {
    type: "local_enu";
    distance_unit: "m";
    time_unit: "s";
    bearing_convention: "clockwise_from_north";
    origin_lat: number;
    origin_lon: number;
  };
  duration_s: number;
  sample_period_s: number;
  sample_times_s: number[];
  terrain: { real_terrain_available: boolean; source: string };
  sensors: Array<{ id: string; type: "rf_aoa"; x_m: number; y_m: number; lat: number; lon: number; mast_m: number; antenna_hae_m?: number; gain_dbi: number; noise_floor_dbm: number; detection_snr_db: number; bearing_sigma_floor_deg: number; bearing_bias_deg: number }>;
  ground_truth: TruthPoint[];
  observations: RfObservation[];
  associations: Array<{ observation_id: string; source_object_id: string }>;
  missed_detections: Array<{ id: string; timestamp_s: number; sensor_id: string; reason: "below_snr_threshold" | "terrain_unavailable"; power_dbm: number | null; snr_db: number | null; terrain_loss_db: number | null; terrain_coverage: number }>;
  missed_detection_associations: Array<{ record_id: string; source_object_id: string }>;
}

/** Approximate local east/north coordinates, with the first receiver as origin. */
function localXY(origin: Cartographic, lon: number, lat: number): [number, number] {
  const target = Cartographic.fromDegrees(lon, lat);
  if (Math.abs(target.longitude - origin.longitude) + Math.abs(target.latitude - origin.latitude) < 1e-12) return [0, 0];
  const path = new EllipsoidGeodesic(origin, target);
  return [path.surfaceDistance * Math.sin(path.startHeading), path.surfaceDistance * Math.cos(path.startHeading)];
}

export class ScenarioCapture {
  private readonly data: ScenarioData;
  private readonly origin: Cartographic;

  constructor(args: {
    scenarioId: string;
    startUtc: string;
    seed: number;
    requestedDurationS: number;
    samplePeriodS: number;
    route: Waypoint[];
    emitter: Emitter;
    receivers: ReceiverSite[];
    realTerrainAvailable: boolean;
    terrainSource: string;
    origin?: { lat: number; lon: number };
    configurationMetadata?: Record<string, unknown>;
  }) {
    if (args.receivers.length < 1) throw new Error("A scenario needs a receiver");
    const first = args.receivers[0] as ReceiverSite;
    const origin = args.origin ?? { lat: first.lat, lon: first.lon };
    this.origin = Cartographic.fromDegrees(origin.lon, origin.lat);
    this.data = {
      schema_version: 1,
      scenario_id: args.scenarioId,
      configuration: {
        start_utc: args.startUtc,
        seed: args.seed,
        route: args.route,
        emitter: args.emitter,
        requested_duration_s: args.requestedDurationS,
        metadata: args.configurationMetadata,
      },
      world_frame: {
        type: "local_enu",
        distance_unit: "m",
        time_unit: "s",
        bearing_convention: "clockwise_from_north",
        origin_lat: origin.lat,
        origin_lon: origin.lon,
      },
      duration_s: 0,
      sample_period_s: args.samplePeriodS,
      sample_times_s: [],
      terrain: { real_terrain_available: args.realTerrainAvailable, source: args.terrainSource },
      sensors: args.receivers.map((rx) => {
        const [x_m, y_m] = localXY(this.origin, rx.lon, rx.lat);
        return { id: rx.uid, type: "rf_aoa", x_m, y_m, lat: rx.lat, lon: rx.lon, mast_m: rx.mastM, gain_dbi: rx.gainDbi, noise_floor_dbm: rx.noiseFloorDbm, detection_snr_db: rx.detectSnrDb, bearing_sigma_floor_deg: rx.sigmaFloorDeg, bearing_bias_deg: rx.biasDeg };
      }),
      ground_truth: [],
      observations: [],
      associations: [],
      missed_detections: [],
      missed_detection_associations: [],
    };
  }

  record(args: {
    timestampS: number;
    drone: Cartographic;
    aglM: number;
    detections: Detection[];
  }): void {
    const timestamp_s = args.timestampS;
    const previous = this.data.sample_times_s.at(-1);
    if (!Number.isFinite(timestamp_s) || timestamp_s < 0 || (previous !== undefined && timestamp_s <= previous)) throw new Error("Capture timestamps must increase");
    const lat = CesiumMath.toDegrees(args.drone.latitude);
    const lon = CesiumMath.toDegrees(args.drone.longitude);
    const [x_m, y_m] = localXY(this.origin, lon, lat);
    const object_id = this.data.configuration.emitter.uid;
    this.data.sample_times_s.push(timestamp_s);
    this.data.ground_truth.push({ timestamp_s, object_id, x_m, y_m, lat, lon, hae_m: args.drone.height, agl_m: args.aglM });
    this.data.duration_s = Math.max(this.data.duration_s, timestamp_s + this.data.sample_period_s);

    for (const detection of args.detections) {
      const knownTerrain = detection.terrainComplete;
      const index = String(this.data.ground_truth.length - 1).padStart(6, "0");
      if (!detection.heard) {
        const id = `miss_${index}_${detection.receiver.uid}`;
        this.data.missed_detections.push({
          id,
          timestamp_s,
          sensor_id: detection.receiver.uid,
          reason: knownTerrain ? "below_snr_threshold" : "terrain_unavailable",
          power_dbm: knownTerrain ? detection.rssiDbm : null,
          snr_db: knownTerrain ? detection.snrDb : null,
          terrain_loss_db: knownTerrain ? detection.terrainLossDb : null,
          terrain_coverage: detection.terrainCoverage,
        });
        this.data.missed_detection_associations.push({ record_id: id, source_object_id: object_id });
        continue;
      }
      const id = `obs_${index}_${detection.receiver.uid}`;
      this.data.observations.push({
        id,
        timestamp_s,
        sensor_id: detection.receiver.uid,
        bearing_deg: bearingInOriginFrame({ lat: CesiumMath.toDegrees(this.origin.latitude), lon: CesiumMath.toDegrees(this.origin.longitude) }, detection.receiver, detection.measuredBearingDeg),
        sensor_bearing_deg: detection.measuredBearingDeg,
        frequency_mhz: this.data.configuration.emitter.freqMhz,
        power_dbm: detection.rssiDbm,
        snr_db: detection.snrDb,
        bearing_sigma_deg: detection.sigmaDeg,
        terrain_loss_db: detection.terrainLossDb,
        terrain_coverage: detection.terrainCoverage,
      });
      this.data.associations.push({ observation_id: id, source_object_id: object_id });
    }
  }

  snapshot(): ScenarioData {
    return structuredClone(this.data);
  }
}

/** Checks the record relationships that the challenge explicitly requires. */
export function validateScenario(data: ScenarioData, options: { allowSyntheticTerrain?: boolean; minDurationS?: number } = {}): string[] {
  const errors: string[] = [];
  if (!options.allowSyntheticTerrain && !data.terrain.real_terrain_available) errors.push("Real terrain was unavailable; this run does not meet the terrain requirement.");
  if (data.duration_s < (options.minDurationS ?? 120)) errors.push("Capture is shorter than a few minutes; keep the run going before presenting it.");
  if (data.ground_truth.length === 0) errors.push("No ground truth was captured.");
  if (data.observations.length === 0) errors.push("No radio observations were captured.");
  const incompleteTerrainPaths = [...data.observations, ...data.missed_detections]
    .filter((item) => item.terrain_coverage < 1 || ("reason" in item && item.reason === "terrain_unavailable")).length;
  if (incompleteTerrainPaths) errors.push(`${incompleteTerrainPaths} RF paths lacked terrain samples; no valid sensor observations were generated for those paths.`);
  const sensorIds = new Set(data.sensors.map((sensor) => sensor.id));
  const truthTimes = new Set(data.ground_truth.map((point) => point.timestamp_s));
  if (data.sample_times_s.length !== data.ground_truth.length) errors.push("Sample clock and truth have different frame counts.");
  for (let index = 0; index < data.sample_times_s.length; index += 1) {
    const time = data.sample_times_s[index] as number;
    if (!truthTimes.has(time)) errors.push(`Sample time ${time} has no truth point.`);
    if (index > 0 && time <= (data.sample_times_s[index - 1] as number)) errors.push("Sample clock is not strictly increasing.");
  }
  const observationIds = new Set<string>();
  for (const observation of data.observations) {
    if (observationIds.has(observation.id)) errors.push(`Duplicate observation ${observation.id}.`);
    observationIds.add(observation.id);
    if (!sensorIds.has(observation.sensor_id)) errors.push(`Unknown sensor ${observation.sensor_id}.`);
    if (!truthTimes.has(observation.timestamp_s)) errors.push(`Observation ${observation.id} has no synchronized truth.`);
    if (!Number.isFinite(observation.bearing_deg) || observation.bearing_deg < 0 || observation.bearing_deg >= 360) errors.push(`Invalid bearing on ${observation.id}.`);
    if (!Number.isFinite(observation.power_dbm) || !Number.isFinite(observation.frequency_mhz)) errors.push(`Invalid RF value on ${observation.id}.`);
  }
  const associations = new Map(data.associations.map((item) => [item.observation_id, item.source_object_id]));
  if (associations.size !== data.associations.length) errors.push("Duplicate observation associations exist.");
  for (const observation of data.observations) {
    if (associations.get(observation.id) !== data.configuration.emitter.uid) errors.push(`Missing or incorrect association for ${observation.id}.`);
  }
  for (const association of data.associations) {
    if (!observationIds.has(association.observation_id)) errors.push(`Association references unknown observation ${association.observation_id}.`);
  }
  const missingAssociations = new Map(data.missed_detection_associations.map((item) => [item.record_id, item.source_object_id]));
  if (missingAssociations.size !== data.missed_detections.length) errors.push("Missing-detection diagnostic associations are incomplete or duplicated.");
  const attempts = new Set(data.observations.map((item) => `${item.timestamp_s}:${item.sensor_id}`));
  for (const miss of data.missed_detections) {
    if (missingAssociations.get(miss.id) !== data.configuration.emitter.uid) errors.push(`Missing association for ${miss.id}.`);
    if (!truthTimes.has(miss.timestamp_s) || !sensorIds.has(miss.sensor_id)) errors.push(`Invalid timestamp or sensor on ${miss.id}.`);
    const key = `${miss.timestamp_s}:${miss.sensor_id}`;
    if (attempts.has(key)) errors.push(`Duplicate RF attempt at ${key}.`);
    attempts.add(key);
  }
  if (attempts.size !== data.sample_times_s.length * data.sensors.length) errors.push("Each receiver needs a detection or a missing-detection record on every sample tick.");
  return errors;
}
