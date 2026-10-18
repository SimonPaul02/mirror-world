import copy
import json
import math
from pathlib import Path

from rf_fusion.evaluation import evaluate_track
from rf_fusion.geometry import bearing_to_unit, triangulate_two_bearings
from rf_fusion.pipeline import estimate_track


FIXTURE = Path(__file__).resolve().parents[1] / "examples/scenario_2d_fixture.json"


def test_bearing_convention_and_perfect_geometry():
    for angle, expected in [(0, (0, 1)), (90, (1, 0)), (180, (0, -1)), (270, (-1, 0))]:
        actual = bearing_to_unit(angle)
        assert math.dist(actual, expected) < 1e-12
    point = triangulate_two_bearings((0, 0), 45, (6000, 0), 315)
    assert point is not None and math.dist(point, (3000, 3000)) < 1e-6


def test_bad_geometry_is_not_a_measurement():
    assert triangulate_two_bearings((0, 0), 0, (6000, 0), 0) is None
    assert triangulate_two_bearings((0, 0), 0, (6000, 0), 180) is None
    assert triangulate_two_bearings((0, 0), 315, (6000, 0), 45) is None


def test_fixture_dropout_and_truth_separation():
    scenario = json.loads(FIXTURE.read_text())
    args = (scenario["sensors"], scenario["observations"], scenario["duration_s"], scenario["sample_period_s"])
    track = estimate_track(*args, scenario_id=scenario["scenario_id"])
    assert len(track["raw_intersections"]) == 25
    assert [p["timestamp_s"] for p in track["points"] if p["status"] == "prediction_only"] == [10, 11, 12, 13, 14]
    assert all(not p["observation_ids_used"] for p in track["points"] if p["status"] == "prediction_only")
    assert math.isfinite(evaluate_track(track, scenario["ground_truth"])["rmse_m"])
    altered = copy.deepcopy(scenario)
    for truth in altered["ground_truth"]:
        truth["x_m"] += 1000
    assert track == estimate_track(altered["sensors"], altered["observations"], altered["duration_s"], altered["sample_period_s"], scenario_id=altered["scenario_id"])
    assert evaluate_track(track, altered["ground_truth"])["rmse_m"] > evaluate_track(track, scenario["ground_truth"])["rmse_m"]


def test_explicit_sample_clock_handles_missing_both_receivers():
    sensors = [{"id": "RF1", "x_m": 0, "y_m": 0}, {"id": "RF2", "x_m": 6000, "y_m": 0}]
    observations = [
        {"id": "a", "sensor_id": "RF1", "timestamp_s": 0.02, "bearing_deg": 45},
        {"id": "b", "sensor_id": "RF2", "timestamp_s": 0.02, "bearing_deg": 315},
    ]
    track = estimate_track(sensors, observations, 4, 2, sample_times_s=[0.02, 2.03])
    assert [point["status"] for point in track["points"]] == ["measurement_update", "prediction_only"]
    assert track["points"][1]["position_sigma_m"] > track["points"][0]["position_sigma_m"]
