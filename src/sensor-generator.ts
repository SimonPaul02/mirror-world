import { Cartographic, EllipsoidGeodesic } from "cesium";

import { mulberry32, toDeg } from "./math";
import type { Emitter, ReceiverSite } from "./scenario";
import { ScenarioCapture, validateScenario } from "./scenario-data";
import { crossBearings, SignalModel } from "./signals";
import { fromLocalXY, makeSensorTerrainSampler, type LocalOrigin, type SensorTerrain } from "./sensor-terrain";
import { parseTrajectory } from "./trajectory";

export interface SensorGeneratorConfig {
  seed: number;
  origin: LocalOrigin;
  emitter: Omit<Emitter, "uid">;
  receivers: Array<Omit<ReceiverSite, "lat" | "lon"> & { x_m: number; y_m: number }>;
  terrain: SensorTerrain;
  noise?: { shadowingSigmaDb?: number; bearingNoiseScale?: number };
}

export function generateRfScenario(trajectoryInput: unknown, config: SensorGeneratorConfig) {
  const trajectory = parseTrajectory(trajectoryInput);
  if (!Number.isInteger(config.seed) || config.seed < 0 || config.seed > 0xffffffff) throw new Error("seed must be an unsigned 32-bit integer");
  if (!config.origin || !Number.isFinite(config.origin.lat) || !Number.isFinite(config.origin.lon) || Math.abs(config.origin.lat) >= 85 || Math.abs(config.origin.lon) > 180) throw new Error("Supply a valid local reference origin");
  if (config.receivers.length !== 2 || new Set(config.receivers.map((rx) => rx.uid)).size !== 2) throw new Error("Configure exactly two distinct AoA receivers");
  for (const rx of config.receivers) {
    if (!rx.uid || ![rx.x_m, rx.y_m, rx.mastM, rx.gainDbi, rx.sigmaFloorDeg, rx.biasDeg, rx.noiseFloorDbm, rx.detectSnrDb].every(Number.isFinite) || rx.mastM <= 0 || rx.sigmaFloorDeg < 0 || rx.detectSnrDb < 0) throw new Error(`Invalid RF receiver ${rx.uid}`);
  }
  if (![config.emitter.freqMhz, config.emitter.eirpDbm, config.emitter.bandwidthMhz].every(Number.isFinite) || config.emitter.freqMhz <= 0 || config.emitter.bandwidthMhz <= 0) throw new Error("Invalid transmitter frequency, power, or bandwidth");
  for (const value of [config.noise?.shadowingSigmaDb ?? 2.6, config.noise?.bearingNoiseScale ?? 1]) {
    if (!Number.isFinite(value) || value < 0) throw new Error("Noise parameters must be nonnegative");
  }
  const terrain = makeSensorTerrainSampler(config.terrain, config.origin);
  const emitter: Emitter = { ...config.emitter, uid: trajectory.ground_truth[0]!.object_id };
  const receivers: ReceiverSite[] = config.receivers.map((rx) => {
    const point = fromLocalXY(config.origin, rx.x_m, rx.y_m);
    return { ...rx, lon: toDeg(point.longitude), lat: toDeg(point.latitude) };
  });
  const baseline = new EllipsoidGeodesic(Cartographic.fromDegrees(receivers[0]!.lon, receivers[0]!.lat), Cartographic.fromDegrees(receivers[1]!.lon, receivers[1]!.lat)).surfaceDistance;
  if (baseline < 1) throw new Error("Receiver sites must be separated");
  const signals = new SignalModel(receivers, emitter, terrain, mulberry32(config.seed), { samplePeriodS: trajectory.sample_period_s, ...config.noise });
  const capture = new ScenarioCapture({
    scenarioId: trajectory.scenario_id,
    startUtc: trajectory.start_utc,
    seed: config.seed,
    requestedDurationS: trajectory.duration_s,
    samplePeriodS: trajectory.sample_period_s,
    route: [],
    emitter,
    receivers,
    realTerrainAvailable: config.terrain.kind === "grid" && config.terrain.real_terrain,
    terrainSource: config.terrain.kind === "synthetic" ? "Synthetic heightfield; Ukrainian coordinates are illustrative, not surveyed terrain" : config.terrain.source,
    origin: config.origin,
    configurationMetadata: {
      sensor_config: structuredClone(config),
      source: "sampled_drone_trajectory",
      noise: "Heuristic AR(1) fading and SNR-dependent AoA errors; not hardware-calibrated",
      terrain_model: "Worst sampled single knife-edge obstruction; not full multipath or multi-edge ray tracing",
    },
  });
  const fixes: Array<{ timestamp_s: number; lat: number; lon: number; cross_angle_deg: number; observation_ids_used: string[] }> = [];
  const rfFrames = [];
  for (const point of trajectory.ground_truth) {
    const drone = Cartographic.fromDegrees(point.lon, point.lat, point.hae_m);
    const ground = terrain(drone);
    if (ground === undefined) throw new Error(`No terrain coverage at drone timestamp ${point.timestamp_s}`);
    if (point.hae_m <= ground) throw new Error(`Drone intersects terrain at timestamp ${point.timestamp_s}`);
    const detections = signals.observe(drone);
    if (detections.some((detection) => !detection.terrainComplete)) throw new Error(`Incomplete receiver/path terrain at timestamp ${point.timestamp_s}; expand the terrain grid`);
    capture.record({ timestampS: point.timestamp_s, drone, aglM: point.hae_m - ground, detections });
    const fix = crossBearings(detections);
    if (fix) fixes.push({ timestamp_s: point.timestamp_s, lat: fix.lat, lon: fix.lon, cross_angle_deg: fix.crossAngleDeg, observation_ids_used: detections.filter((d) => fix.contributors.includes(d.receiver.uid)).map((d) => `obs_${String(rfFrames.length).padStart(6, "0")}_${d.receiver.uid}`) });
    rfFrames.push({
      timestamp_s: point.timestamp_s,
      receivers: detections.map((d) => ({ sensor_id: d.receiver.uid, detected: d.heard, power_dbm: d.rssiDbm, snr_db: d.snrDb, free_space_loss_db: d.fsplDb, terrain_loss_db: d.terrainLossDb, terrain_coverage: d.terrainCoverage, bearing_sigma_deg: d.sigmaDeg })),
    });
  }
  const scenario = capture.snapshot();
  for (const sensor of scenario.sensors) sensor.antenna_hae_m = signals.antennaHae(receivers.find((rx) => rx.uid === sensor.id)!);
  const errors = validateScenario(scenario, { allowSyntheticTerrain: true, minDurationS: 0 });
  if (errors.length) throw new Error(`Scenario integrity failed: ${errors.join(" ")}`);
  const warnings = validateScenario(scenario);
  const report = {
    scenario_id: scenario.scenario_id,
    structural_validation_passed: true,
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
    })),
  };
  return { scenario, report, fixes, rfFrames };
}
