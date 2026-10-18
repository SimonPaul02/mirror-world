"""Truth comparison happens after, and outside, the estimator."""

import math


def evaluate_track(estimated_track: dict, ground_truth: list[dict]) -> dict:
    truth_by_time = {row["timestamp_s"]: row for row in ground_truth}

    def errors_for(rows):
        return [
            math.hypot(point["x_m"] - truth_by_time[point["timestamp_s"]]["x_m"], point["y_m"] - truth_by_time[point["timestamp_s"]]["y_m"])
            for point in rows if point["timestamp_s"] in truth_by_time
        ]

    def rmse(values):
        return math.sqrt(sum(value * value for value in values) / len(values)) if values else None

    points = estimated_track["points"]
    errors = errors_for(points)
    return {
        "scenario_id": estimated_track["scenario_id"],
        "rmse_m": rmse(errors),
        "raw_rmse_m": rmse(errors_for(estimated_track["raw_intersections"])),
        "measurement_update_rmse_m": rmse(errors_for([point for point in points if point["status"] == "measurement_update"])),
        "prediction_only_rmse_m": rmse(errors_for([point for point in points if point["status"] == "prediction_only"])),
        "mean_error_m": sum(errors) / len(errors) if errors else None,
        "max_error_m": max(errors) if errors else None,
        "compared_frames": len(errors),
        "total_frames": estimated_track["total_frames"],
        "frames_with_two_readings": estimated_track["frames_with_two_readings"],
        "successful_triangulations": len(estimated_track["raw_intersections"]),
        "measurement_update_frames": sum(p["status"] == "measurement_update" for p in points),
        "prediction_only_frames": sum(p["status"] == "prediction_only" for p in points),
        "innovation_rejections": sum(p.get("prediction_reason") == "innovation_gate" for p in points),
    }
