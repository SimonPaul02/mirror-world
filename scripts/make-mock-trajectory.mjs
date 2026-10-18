import { writeFileSync } from "node:fs";
import { fromLocalXY } from "../src/sensor-terrain.ts";
import { toDeg } from "../src/math.ts";

const origin = { lat: 49.3754, lon: 31.1882 };
const trajectory = {
  scenario_id: "mock_ukraine_60s",
  description: "Illustrative small fixed-wing UAV, about 30 m/s, gentle curve, 200 m above the synthetic terrain beneath its route. Not an actual flight or real terrain survey.",
  start_utc: "2026-11-03T12:10:00Z",
  coordinate_frame: "wgs84",
  height_reference: "ellipsoid",
  duration_s: 60,
  sample_period_s: 1,
  ground_truth: Array.from({ length: 60 }, (_, timestamp_s) => {
    const point = fromLocalXY(origin, -900 + 30 * timestamp_s, 2500 + 150 * Math.sin(Math.PI * timestamp_s / 60), 300);
    return { timestamp_s, object_id: "D1", lat: toDeg(point.latitude), lon: toDeg(point.longitude), hae_m: point.height };
  }),
};
writeFileSync("examples/drone_trajectory_mock_60s.json", JSON.stringify(trajectory, null, 2) + "\n");
console.log("Wrote examples/drone_trajectory_mock_60s.json (60 samples, simulation seconds 0-59)");
