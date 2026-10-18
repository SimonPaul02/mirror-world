"""Estimate from receiver poses, bearings, and a sample clock only."""

from .geometry import triangulate_two_bearings
from .tracking import ConstantVelocityTracker


def estimate_track(
    sensors: list[dict],
    observations: list[dict],
    duration_s: float,
    sample_period_s: float,
    *,
    sample_times_s: list[float] | None = None,
    scenario_id: str = "scenario",
) -> dict:
    if len(sensors) != 2:
        raise ValueError("This estimator requires exactly two AoA receivers")
    if sample_period_s <= 0 or duration_s <= 0:
        raise ValueError("Positive duration and sample period required")
    if sample_times_s is None:
        sample_times_s = [round(i * sample_period_s, 9) for i in range(int(duration_s / sample_period_s + 1e-9))]
    times = sorted(sample_times_s)
    if len(times) != len(set(times)):
        raise ValueError("Sample clock contains duplicate timestamps")
    sensor_by_id = {sensor["id"]: sensor for sensor in sensors}
    if len(sensor_by_id) != 2:
        raise ValueError("Receiver IDs must be unique")
    paired: dict[float, dict[str, dict]] = {}
    valid_times = set(times)
    for observation in observations:
        timestamp = observation["timestamp_s"]
        sensor_id = observation["sensor_id"]
        if timestamp not in valid_times or sensor_id not in sensor_by_id:
            raise ValueError("Observation has an unknown sample time or receiver")
        slot = paired.setdefault(timestamp, {})
        if sensor_id in slot:
            raise ValueError("Duplicate receiver observation at one timestamp")
        slot[sensor_id] = observation

    left, right = sensors
    tracker = None
    previous_time = None
    points = []
    raw_points = []
    paired_count = 0
    for timestamp in times:
        reports = paired.get(timestamp, {})
        measured = None
        ids = []
        if left["id"] in reports and right["id"] in reports:
            paired_count += 1
            a, b = reports[left["id"]], reports[right["id"]]
            measured = triangulate_two_bearings(
                (left["x_m"], left["y_m"]), a["bearing_deg"],
                (right["x_m"], right["y_m"]), b["bearing_deg"],
            )
            ids = [a["id"], b["id"]]
        if measured is not None:
            raw_points.append({"timestamp_s": timestamp, "x_m": measured[0], "y_m": measured[1]})
        if tracker is None:
            if measured is None:
                continue
            tracker = ConstantVelocityTracker(measured)
            status = "measurement_update"
        else:
            tracker.predict(timestamp - previous_time)
            if measured is not None:
                tracker.update(measured)
                status = "measurement_update"
            else:
                status = "prediction_only"
        previous_time = timestamp
        state = tracker.state
        points.append({
            "timestamp_s": timestamp,
            "x_m": float(state[0]), "y_m": float(state[1]),
            "vx_mps": float(state[2]), "vy_mps": float(state[3]),
            "position_sigma_m": float((tracker.covariance[0, 0] + tracker.covariance[1, 1]) ** 0.5),
            "status": status,
            "observation_ids_used": ids if status == "measurement_update" else [],
        })
    return {
        "scenario_id": scenario_id,
        "track_id": "track_1",
        "method": "two_ray_triangulation+constant_velocity_kalman",
        "total_frames": len(times),
        "frames_with_two_readings": paired_count,
        "raw_intersections": raw_points,
        "points": points,
    }
