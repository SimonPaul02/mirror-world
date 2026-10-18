import { Cartographic, EllipsoidGeodesic } from "cesium";

import { mulberry32, toDeg } from "./math";
import { bearingEvent, fixEvent, receiverEvent, toXml, type CotRecord } from "./cot";
import type { Emitter, ReceiverSite } from "./scenario";
import { ScenarioCapture, validateScenario } from "./scenario-data";
import { crossBearings, SignalModel, type Detection, type Fix } from "./signals";
import { fromLocalXY, makeSensorTerrainSampler, type LocalOrigin, type SensorTerrain } from "./sensor-terrain";
import { parseTrajectory } from "./trajectory";

export interface SensorGeneratorConfig {
  seed: number;
  origin: LocalOrigin;
  emitter: Omit<Emitter, "uid">;
  receivers: Array<Omit<ReceiverSite, "lat" | "lon"> & { x_m?: number; y_m?: number; lat?: number; lon?: number }>;
  terrain: SensorTerrain;
  noise?: { shadowingSigmaDb?: number; bearingNoiseScale?: number };
  propagation?: { clutterM?: number; terrainSampleSpacingM?: number };
}

export interface VerifiedTerrain {
  sample: (point: Cartographic) => number | undefined;
  source: string;
  real: boolean;
  provenance?: Record<string, unknown>;
}

export interface RfDiagnosticFrame {
  timestamp_s: number;
  receivers: Array<{ sensor_id: string; detected: boolean; range_m: number; power_dbm: number; snr_db: number; free_space_loss_db: number; terrain_loss_db: number; terrain_coverage: number; bearing_sigma_deg: number }>;
}

export function generateRfScenario(trajectoryInput: unknown, config: SensorGeneratorConfig, verifiedTerrain?: VerifiedTerrain) {
  const trajectory = parseTrajectory(trajectoryInput);
  if (!Number.isInteger(config.seed) || config.seed < 0 || config.seed > 0xffffffff) throw new Error("seed must be an unsigned 32-bit integer");
  if (!config.origin || !Number.isFinite(config.origin.lat) || !Number.isFinite(config.origin.lon) || Math.abs(config.origin.lat) >= 85 || Math.abs(config.origin.lon) > 180) throw new Error("Supply a valid local reference origin");
  if (config.receivers.length > 12 || new Set(config.receivers.map((rx) => rx.uid)).size !== config.receivers.length) throw new Error("Configure 0–12 AoA receivers with distinct IDs");
  for (const rx of config.receivers) {
    const local = rx.x_m !== undefined || rx.y_m !== undefined;
    const geographic = rx.lat !== undefined || rx.lon !== undefined;
    const position = geographic ? [rx.lat, rx.lon] : [rx.x_m, rx.y_m];
    if (local === geographic || !position.every(Number.isFinite) || (geographic && (Math.abs(rx.lat!) > 90 || Math.abs(rx.lon!) > 180))) throw new Error(`Supply either lat/lon or local x_m/y_m for receiver ${rx.uid}`);
    if (!rx.uid || ![rx.mastM, rx.gainDbi, rx.sigmaFloorDeg, rx.biasDeg, rx.noiseFloorDbm, rx.detectSnrDb].every(Number.isFinite) || rx.mastM <= 0 || rx.sigmaFloorDeg < 0 || rx.detectSnrDb < 0) throw new Error(`Invalid RF receiver ${rx.uid}`);
  }
  if (![config.emitter.freqMhz, config.emitter.eirpDbm, config.emitter.bandwidthMhz].every(Number.isFinite) || config.emitter.freqMhz <= 0 || config.emitter.bandwidthMhz <= 0) throw new Error("Invalid transmitter frequency, power, or bandwidth");
  for (const value of [config.noise?.shadowingSigmaDb ?? 2.6, config.noise?.bearingNoiseScale ?? 1]) {
    if (!Number.isFinite(value) || value < 0) throw new Error("Noise parameters must be nonnegative");
  }
  if (!Number.isFinite(config.propagation?.clutterM ?? 6) || (config.propagation?.clutterM ?? 6) < 0 || !Number.isFinite(config.propagation?.terrainSampleSpacingM ?? 100) || (config.propagation?.terrainSampleSpacingM ?? 100) <= 0) throw new Error("Invalid terrain propagation parameters");
  const terrain = verifiedTerrain?.sample ?? makeSensorTerrainSampler(config.terrain, config.origin);
  const emitter: Emitter = { ...config.emitter, uid: trajectory.ground_truth[0]!.object_id };
  const receivers: ReceiverSite[] = config.receivers.map((rx) => {
    if (rx.lat !== undefined && rx.lon !== undefined) return { ...rx, lat: rx.lat, lon: rx.lon };
    const point = fromLocalXY(config.origin, rx.x_m!, rx.y_m!);
    return { ...rx, lon: toDeg(point.longitude), lat: toDeg(point.latitude) };
  });
  let baseline = 0;
  for (let i=0;i<receivers.length;i++) for (let j=i+1;j<receivers.length;j++) {
    const distance = new EllipsoidGeodesic(Cartographic.fromDegrees(receivers[i]!.lon, receivers[i]!.lat), Cartographic.fromDegrees(receivers[j]!.lon, receivers[j]!.lat)).surfaceDistance;
    if (distance < 1) throw new Error("Receiver sites must be separated");
    baseline = Math.max(baseline,distance);
  }
  const signals = new SignalModel(receivers, emitter, terrain, mulberry32(config.seed), { samplePeriodS: trajectory.sample_period_s, ...config.noise, ...config.propagation });
  const capture = new ScenarioCapture({
    scenarioId: trajectory.scenario_id,
    startUtc: trajectory.start_utc,
    seed: config.seed,
    requestedDurationS: trajectory.duration_s,
    samplePeriodS: trajectory.sample_period_s,
    route: [],
    emitter,
    receivers,
    realTerrainAvailable: verifiedTerrain?.real ?? (config.terrain.kind === "grid" && config.terrain.real_terrain),
    terrainSource: verifiedTerrain?.source ?? (config.terrain.kind === "synthetic" ? "Synthetic heightfield; Ukrainian coordinates are illustrative, not surveyed terrain" : config.terrain.source),
    origin: config.origin,
    configurationMetadata: {
      sensor_config: structuredClone(config),
      source: "sampled_drone_trajectory",
      noise: "Heuristic AR(1) fading and SNR-dependent AoA errors; not hardware-calibrated",
      terrain_model: "Worst sampled single knife-edge obstruction; not full multipath or multi-edge ray tracing",
      terrain_provenance: verifiedTerrain?.provenance,
    },
  });
  const fixes: Array<{ timestamp_s: number; lat: number; lon: number; cross_angle_deg: number; observation_ids_used: string[] }> = [];
  const rfFrames: RfDiagnosticFrame[] = [];
  const replayFrames: Array<{ timestamp_s: number; detections: Detection[]; fix?: Fix }> = [];
  const cotRecords: CotRecord[] = receivers.map((rx) => ({
    ...receiverEvent(rx, signals.antennaHae(rx), new Date(trajectory.start_utc)),
    // Sites are fixed scenario truth: keep them valid through the entire capture.
    stale: new Date(Date.parse(trajectory.start_utc) + (trajectory.duration_s + 60) * 1000),
  }));
  for (const point of trajectory.ground_truth) {
    const drone = Cartographic.fromDegrees(point.lon, point.lat, point.hae_m);
    const ground = terrain(drone);
    if (ground === undefined) throw new Error(`No terrain coverage at drone timestamp ${point.timestamp_s}`);
    if (point.hae_m <= ground) throw new Error(`Drone intersects terrain at timestamp ${point.timestamp_s}`);
    const detections = signals.observe(drone);
    if (detections.some((detection) => !detection.terrainComplete)) throw new Error(`Incomplete receiver/path terrain at timestamp ${point.timestamp_s}; expand the terrain grid`);
    capture.record({ timestampS: point.timestamp_s, drone, aglM: point.hae_m - ground, detections });
    const fix = crossBearings(detections);
    replayFrames.push({ timestamp_s: point.timestamp_s, detections, fix });
    const now = new Date(Date.parse(trajectory.start_utc) + point.timestamp_s * 1000);
    const sequence = rfFrames.length + 1;
    for (const detection of detections) {
      if (detection.heard) cotRecords.push(bearingEvent(detection, emitter, sequence, now, `obs_${String(rfFrames.length).padStart(6, "0")}_${detection.receiver.uid}`));
    }
    if (fix) cotRecords.push(fixEvent(fix, detections, emitter, sequence, now, undefined, undefined));
    if (fix) fixes.push({ timestamp_s: point.timestamp_s, lat: fix.lat, lon: fix.lon, cross_angle_deg: fix.crossAngleDeg, observation_ids_used: detections.filter((d) => fix.contributors.includes(d.receiver.uid)).map((d) => `obs_${String(rfFrames.length).padStart(6, "0")}_${d.receiver.uid}`) });
    rfFrames.push({
      timestamp_s: point.timestamp_s,
      receivers: detections.map((d) => ({ sensor_id: d.receiver.uid, detected: d.heard, range_m: d.slantRangeM, power_dbm: d.rssiDbm, snr_db: d.snrDb, free_space_loss_db: d.fsplDb, terrain_loss_db: d.terrainLossDb, terrain_coverage: d.terrainCoverage, bearing_sigma_deg: d.sigmaDeg })),
    });
  }
  const scenario = capture.snapshot();
  for (const sensor of scenario.sensors) sensor.antenna_hae_m = signals.antennaHae(receivers.find((rx) => rx.uid === sensor.id)!);
  const errors = validateScenario(scenario, { allowSyntheticTerrain: true, minDurationS: 0, allowNoObservations: true });
  if (errors.length) throw new Error(`Scenario integrity failed: ${errors.join(" ")}`);
  const warnings = validateScenario(scenario);
  const report = {
    scenario_id: scenario.scenario_id,
    structural_validation_passed: true,
    validation_scope: "Scenario structure, timing, terrain coverage, and duration; RF hardware realism is not calibrated",
    challenge_ready: warnings.length === 0,
    warnings,
    receiver_baseline_m: baseline,
    sample_count: scenario.ground_truth.length,
    observations: scenario.observations.length,
    missed_detections: scenario.missed_detections.length,
    successful_bearing_crossings: fixes.length,
    crossing_angle_deg: fixes.length ? { min: Math.min(...fixes.map((fix) => fix.cross_angle_deg)), max: Math.max(...fixes.map((fix) => fix.cross_angle_deg)) } : null,
    receivers: receivers.map((rx) => ({
      id: rx.uid,
      detections: scenario.observations.filter((point) => point.sensor_id === rx.uid).length,
      misses: scenario.missed_detections.filter((point) => point.sensor_id === rx.uid).length,
      lat: rx.lat,
      lon: rx.lon,
      antenna_hae_m: signals.antennaHae(rx),
      power_dbm: {
        min: Math.min(...rfFrames.map((frame) => frame.receivers.find((item) => item.sensor_id === rx.uid)!.power_dbm)),
        max: Math.max(...rfFrames.map((frame) => frame.receivers.find((item) => item.sensor_id === rx.uid)!.power_dbm)),
      },
      max_terrain_loss_db: Math.max(...rfFrames.map((frame) => frame.receivers.find((item) => item.sensor_id === rx.uid)!.terrain_loss_db)),
    })),
  };
  const cot = `<?xml version="1.0" encoding="UTF-8"?>\n<events>\n${cotRecords.map(toXml).join("\n")}\n</events>\n`;
  const cotAssociations = cotRecords.map((record) => ({ record_id: record.uid, timestamp_utc: record.time.toISOString(), source_object_id: record.object }));
  return { scenario, report, fixes, rfFrames, replayFrames, cot, cotAssociations };
}
