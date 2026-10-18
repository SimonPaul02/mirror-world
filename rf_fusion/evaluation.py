"""Truth comparison happens after, and outside, the estimator."""

import math


def evaluate_track(estimated_track: dict, ground_truth: list[dict]) -> dict:
    truth_by_time = {row["timestamp_s"]: row for row in ground_truth}
    errors = []
    for point in estimated_track["points"]:
        truth = truth_by_time.get(point["timestamp_s"])
        if truth is not None:
            errors.append(math.hypot(point["x_m"] - truth["x_m"], point["y_m"] - truth["y_m"]))
    points = estimated_track["points"]
    return {
        "scenario_id": estimated_track["scenario_id"],
        "rmse_m": math.sqrt(sum(error * error for error in errors) / len(errors)) if errors else None,
        "mean_error_m": sum(errors) / len(errors) if errors else None,
        "max_error_m": max(errors) if errors else None,
        "compared_frames": len(errors),
        "total_frames": estimated_track["total_frames"],
        "frames_with_two_readings": estimated_track["frames_with_two_readings"],
        "successful_triangulations": len(estimated_track["raw_intersections"]),
        "measurement_update_frames": sum(p["status"] == "measurement_update" for p in points),
        "prediction_only_frames": sum(p["status"] == "prediction_only" for p in points),
    }
