"""Check generated RF JSON and TAK XML against each other, using stdlib only."""

import argparse
from datetime import datetime, timedelta
import json
import math
from pathlib import Path
import xml.etree.ElementTree as ET


def validate_export(directory: Path) -> dict:
    read = lambda name: json.loads((directory / name).read_text(encoding="utf-8"))
    scenario = read("scenario.json")
    track = read("estimated_track.json")
    metrics = read("metrics.json")
    answer_key = read("cot_answer_key.json")
    events = list(ET.parse(directory / "sensor_trace.cot").getroot())
    by_id = {event.attrib["uid"]: event for event in events}
    key_by_id = {item["record_id"]: item for item in answer_key}
    if len(by_id) != len(events) or len(key_by_id) != len(answer_key) or set(by_id) != set(key_by_id):
        raise ValueError("TAK event IDs must be unique and match the answer key exactly")
    for event_id, event in by_id.items():
        source = event.find("./detail/_mirrorworld")
        if source is None or source.attrib["object"] != key_by_id[event_id]["source_object_id"] or event.attrib["time"] != key_by_id[event_id]["timestamp_utc"]:
            raise ValueError("A TAK record's embedded provenance disagrees with its answer key")
    associations = {item["observation_id"]: item["source_object_id"] for item in scenario["associations"]}
    observations = {item["id"]: item for item in scenario["observations"]}
    if len(observations) != len(scenario["observations"]) or set(observations) != set(associations):
        raise ValueError("RF observations must have unique IDs and complete associations")
    start = datetime.fromisoformat(scenario["configuration"]["start_utc"].replace("Z", "+00:00"))
    sensors = {sensor["id"]: sensor for sensor in scenario["sensors"]}
    for observation in observations.values():
        event = by_id[observation["id"]]
        expected_time = start + timedelta(seconds=observation["timestamp_s"])
        actual_time = datetime.fromisoformat(event.attrib["time"].replace("Z", "+00:00"))
        if abs((actual_time - expected_time).total_seconds()) > 0.001:
            raise ValueError("A TAK signal is not synchronized with the RF JSON")
        signal = event.find("./detail/__signal")
        if signal is None or signal.attrib["sensor"] != observation["sensor_id"]:
            raise ValueError("TAK signal has a missing or inconsistent receiver")
        for xml_name, json_value, tolerance in [
            ("freq_mhz", observation["frequency_mhz"], 1e-6),
            ("power_dbm", observation["power_dbm"], 0.051),
            ("bearing_deg", observation.get("sensor_bearing_deg", observation["bearing_deg"]), 0.051),
        ]:
            if not math.isclose(float(signal.attrib[xml_name]), json_value, abs_tol=tolerance):
                raise ValueError(f"TAK {xml_name} differs from its RF observation")
        if key_by_id[observation["id"]]["source_object_id"] != associations[observation["id"]]:
            raise ValueError("TAK and JSON answer keys disagree")
        sensor = sensors[observation["sensor_id"]]
        point = event.find("point")
        if point is None or abs(float(point.attrib["lat"]) - sensor["lat"]) > 0.00000051 or abs(float(point.attrib["lon"]) - sensor["lon"]) > 0.00000051:
            raise ValueError("A bearing-only event must be located at its receiver")
    for point in track["points"]:
        used = point["observation_ids_used"]
        if point["status"] == "prediction_only" and used:
            raise ValueError("A prediction-only point claims to use observations")
        if point["status"] == "measurement_update" and (len(used) < 2 or len({observations[item]["sensor_id"] for item in used}) < 2):
            raise ValueError("A position update needs at least two distinct receivers")
        if any(observations[item]["timestamp_s"] != point["timestamp_s"] for item in used):
            raise ValueError("A track update used observations from a different timestamp")
    return {
        "passed": True,
        "scope": "Output structure, associations, synchronized UTC, RF values, and tracker observation provenance; not RF hardware calibration",
        "scenario_id": scenario["scenario_id"],
        "truth_frames": len(scenario["ground_truth"]),
        "rf_observations": len(observations),
        "missed_detections": len(scenario["missed_detections"]),
        "tak_events": len(events),
        "track_frames": len(track["points"]),
        "raw_rmse_m": metrics["raw_rmse_m"],
        "filtered_rmse_m": metrics["rmse_m"],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    directory = parser.parse_args().directory
    report = validate_export(directory)
    (directory / "validation.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
