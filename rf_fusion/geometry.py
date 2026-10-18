"""Forward-ray triangulation in local east/north metres."""

import math


def bearing_to_unit(bearing_deg: float) -> tuple[float, float]:
    angle = math.radians(bearing_deg)
    return math.sin(angle), math.cos(angle)


def _cross(a: tuple[float, float], b: tuple[float, float]) -> float:
    return a[0] * b[1] - a[1] * b[0]


def triangulate_two_bearings(
    sensor1_xy: tuple[float, float],
    bearing1_deg: float,
    sensor2_xy: tuple[float, float],
    bearing2_deg: float,
    min_sin_angle: float = 0.15,
    max_range_m: float | None = 200_000.0,
) -> tuple[float, float] | None:
    values = (*sensor1_xy, bearing1_deg, *sensor2_xy, bearing2_deg)
    if not all(math.isfinite(value) for value in values):
        return None
    u1, u2 = bearing_to_unit(bearing1_deg), bearing_to_unit(bearing2_deg)
    denominator = _cross(u1, u2)
    if abs(denominator) < min_sin_angle:
        return None
    baseline = (sensor2_xy[0] - sensor1_xy[0], sensor2_xy[1] - sensor1_xy[1])
    t1 = _cross(baseline, u2) / denominator
    t2 = _cross(baseline, u1) / denominator
    if t1 < 0 or t2 < 0 or (max_range_m is not None and max(t1, t2) > max_range_m):
        return None
    result = sensor1_xy[0] + t1 * u1[0], sensor1_xy[1] + t1 * u1[1]
    return result if all(map(math.isfinite, result)) else None
