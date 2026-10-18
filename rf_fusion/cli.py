"""Run the independent RF fusion demo against fixture or generator JSON."""

import argparse
import json
from pathlib import Path

from .evaluation import evaluate_track
from .pipeline import estimate_track
from .visualization import save_comparison_png, save_rf_diagnostics_png


def main() -> None:
    parser = argparse.ArgumentParser(description="Estimate a 2D track from synthetic RF bearings")
    parser.add_argument("--scenario", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--diagnostics", type=Path, help="Optional generated rf_diagnostics.json for the RF trace plot")
    args = parser.parse_args()
    with args.scenario.open(encoding="utf-8") as handle:
        scenario = json.load(handle)
    frame = scenario.get("world_frame", {})
    if frame.get("type") != "local_enu" or frame.get("bearing_convention") != "clockwise_from_north":
        parser.error("Expected local ENU metres and clockwise-from-North bearings")
    track = estimate_track(
        scenario["sensors"], scenario["observations"],
        scenario["duration_s"], scenario["sample_period_s"],
        sample_times_s=scenario.get("sample_times_s"), scenario_id=scenario["scenario_id"],
    )
    metrics = evaluate_track(track, scenario.get("ground_truth", []))
    args.output.mkdir(parents=True, exist_ok=True)
    track_path = args.output / "estimated_track.json"
    metrics_path = args.output / "metrics.json"
    plot_path = args.output / "trajectory_comparison.png"
    track_path.write_text(json.dumps(track, indent=2) + "\n", encoding="utf-8")
    metrics_path.write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf-8")
    save_comparison_png(str(plot_path), scenario["sensors"], scenario.get("ground_truth", []), track)
    if args.diagnostics:
        frames = json.loads(args.diagnostics.read_text(encoding="utf-8"))
        save_rf_diagnostics_png(str(args.output / "rf_behavior.png"), frames, scenario["sensors"])
    print(f"Triangulations: {metrics['successful_triangulations']}")
    print(f"Prediction-only frames: {metrics['prediction_only_frames']}")
    print(f"RMSE: {metrics['rmse_m']:.1f} m" if metrics["rmse_m"] is not None else "RMSE: unavailable (no matching truth)")
    print(f"Wrote {track_path}, {metrics_path}, {plot_path}")


if __name__ == "__main__":
    main()
