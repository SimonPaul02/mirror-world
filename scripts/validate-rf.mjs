import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Cartographic, EllipsoidGeodesic } from "cesium";
import { generateRfScenario } from "../src/sensor-generator.ts";
import { fsplDb } from "../src/signals.ts";

const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const trajectory = read("examples/drone_trajectory_mock_60s.json");
const ridgeConfig = read("examples/rf_sensor_config.json");
ridgeConfig.noise = { shadowingSigmaDb: 0, bearingNoiseScale: 0 };
for (const receiver of ridgeConfig.receivers) receiver.biasDeg = 0;
const clearConfig = structuredClone(ridgeConfig);
delete clearConfig.terrain.ridge;
const clear = generateRfScenario(trajectory, clearConfig);
const ridge = generateRfScenario(trajectory, ridgeConfig);
const truth = new Map(trajectory.ground_truth.map((point) => [point.timestamp_s, point]));
const crossingErrors = clear.fixes.map((fix) => {
  const point = truth.get(fix.timestamp_s);
  return new EllipsoidGeodesic(Cartographic.fromDegrees(fix.lon, fix.lat), Cartographic.fromDegrees(point.lon, point.lat)).surfaceDistance;
});
const doublingLossDb = fsplDb(2000, 2437.5) - fsplDb(1000, 2437.5);
const receivers = ridgeConfig.receivers.map((receiver) => {
  const clearData = clear.rfFrames.map((frame) => frame.receivers.find((item) => item.sensor_id === receiver.uid));
  const ridgeData = ridge.rfFrames.map((frame) => frame.receivers.find((item) => item.sensor_id === receiver.uid));
  return {
    id: receiver.uid,
    clear_detections: clearData.filter((item) => item.detected).length,
    ridge_detections: ridgeData.filter((item) => item.detected).length,
    blocked_timestamps_s: ridge.rfFrames.filter((frame) => !frame.receivers.find((item) => item.sensor_id === receiver.uid).detected).map((frame) => frame.timestamp_s),
    max_additional_terrain_loss_db: Math.max(...ridgeData.map((item, index) => item.terrain_loss_db - clearData[index].terrain_loss_db)),
    weakest_clear_power_dbm: Math.min(...clearData.map((item) => item.power_dbm)),
    weakest_ridge_power_dbm: Math.min(...ridgeData.map((item) => item.power_dbm)),
  };
});
assert.ok(Math.abs(doublingLossDb - 6.020599913) < 1e-6);
assert.equal(clear.fixes.length, 60);
assert.ok(Math.max(...crossingErrors) < 2);
assert.equal(receivers[0].ridge_detections, 60);
assert.ok(receivers[1].ridge_detections < receivers[1].clear_detections);
assert.ok(receivers[1].max_additional_terrain_loss_db > 20);
const report = {
  passed: true,
  validation_scope: "Controlled mathematical/geometry checks on synthetic terrain, not calibration against real radio measurements",
  checks: { free_space_distance_doubling_db: doublingLossDb, perfect_bearing_crossing_max_error_m: Math.max(...crossingErrors), clear_path_fixes: clear.fixes.length, receiver_comparison: receivers },
  reproducible_command: "npm run validate:rf",
};
mkdirSync("outputs/mock_60s", { recursive: true });
writeFileSync("outputs/mock_60s/rf_validation.json", JSON.stringify(report, null, 2) + "\n");
writeFileSync("outputs/mock_60s/clear_scenario.json", JSON.stringify(clear.scenario, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
