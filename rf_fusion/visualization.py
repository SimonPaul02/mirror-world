"""Small standalone PNG plot using Pillow, available in this workspace."""

from PIL import Image, ImageDraw


def save_comparison_png(path: str, sensors: list[dict], truth: list[dict], track: dict) -> None:
    width, height = 1000, 750
    margin = 82
    series = [
        [(p["x_m"], p["y_m"]) for p in truth],
        [(p["x_m"], p["y_m"]) for p in track["raw_intersections"]],
        [(p["x_m"], p["y_m"]) for p in track["points"]],
        [(p["x_m"], p["y_m"]) for p in sensors],
    ]
    all_points = [point for part in series for point in part]
    image = Image.new("RGB", (width, height), "#ffffff")
    draw = ImageDraw.Draw(image)
    if not all_points:
        draw.text((margin, margin), "No positions available", fill="#111827")
        image.save(path)
        return
    x_min = min(p[0] for p in all_points)
    x_max = max(p[0] for p in all_points)
    y_min = min(p[1] for p in all_points)
    y_max = max(p[1] for p in all_points)
    plot_width, plot_height = width - 2 * margin, height - 2 * margin
    scale = min(plot_width / max(x_max - x_min, 1), plot_height / max(y_max - y_min, 1)) * 0.88
    x_mid, y_mid = (x_min + x_max) / 2, (y_min + y_max) / 2

    def screen(point: tuple[float, float]) -> tuple[int, int]:
        return round(width / 2 + (point[0] - x_mid) * scale), round(height / 2 - (point[1] - y_mid) * scale)

    draw.rectangle((margin, margin, width - margin, height - margin), outline="#9ca3af", width=2)
    draw.text((margin, 30), "RF trajectory: truth, raw intersections, and filtered estimate", fill="#111827")
    draw.text((width // 2 - 35, height - 38), "East (m)", fill="#374151")
    draw.text((12, height // 2), "North (m)", fill="#374151")
    for points, color, line_width in ((series[0], "#15803d", 3), (series[2], "#1d4ed8", 3)):
        if len(points) >= 2:
            draw.line([screen(point) for point in points], fill=color, width=line_width)
    for point in series[1]:
        x, y = screen(point)
        draw.ellipse((x - 2, y - 2, x + 2, y + 2), fill="#f59e0b")
    for point in track["points"]:
        if point["status"] == "prediction_only":
            x, y = screen((point["x_m"], point["y_m"]))
            draw.ellipse((x - 3, y - 3, x + 3, y + 3), outline="#9333ea")
    for sensor in sensors:
        x, y = screen((sensor["x_m"], sensor["y_m"]))
        draw.rectangle((x - 6, y - 6, x + 6, y + 6), fill="#111827")
        draw.text((x + 9, y - 9), sensor["id"], fill="#111827")
    # The receiver baseline can dwarf the track; show its errors in a detail inset.
    detail = [point for part in series[:3] for point in part]
    if detail:
        box = (105, 105, 435, 335)
        draw.rectangle(box, fill="#ffffff", outline="#9ca3af", width=2)
        draw.text((box[0] + 10, box[1] + 8), "Trajectory detail", fill="#111827")
        dx_min, dx_max = min(p[0] for p in detail), max(p[0] for p in detail)
        dy_min, dy_max = min(p[1] for p in detail), max(p[1] for p in detail)
        detail_scale = min(280 / max(dx_max - dx_min, 1), 165 / max(dy_max - dy_min, 1)) * 0.85
        dx_mid, dy_mid = (dx_min + dx_max) / 2, (dy_min + dy_max) / 2

        def detail_screen(point: tuple[float, float]) -> tuple[int, int]:
            return round(270 + (point[0] - dx_mid) * detail_scale), round(225 - (point[1] - dy_mid) * detail_scale)

        for points, color in ((series[0], "#15803d"), (series[2], "#1d4ed8")):
            if len(points) >= 2:
                draw.line([detail_screen(point) for point in points], fill=color, width=3)
        for point in series[1]:
            x, y = detail_screen(point)
            draw.ellipse((x - 2, y - 2, x + 2, y + 2), fill="#f59e0b")
        for point in track["points"]:
            if point["status"] == "prediction_only":
                x, y = detail_screen((point["x_m"], point["y_m"]))
                draw.ellipse((x - 3, y - 3, x + 3, y + 3), outline="#9333ea")
    for index, (label, color) in enumerate((
        ("Truth", "#15803d"), ("Raw intersection", "#f59e0b"),
        ("Filtered estimate", "#1d4ed8"), ("RF sites", "#111827"), ("Prediction only", "#9333ea"),
    )):
        draw.rectangle((margin + index * 165, height - 65, margin + 13 + index * 165, height - 52), fill=color)
        draw.text((margin + 19 + index * 165, height - 65), label, fill="#111827")
    image.save(path)


def save_rf_diagnostics_png(path: str, frames: list[dict], sensors: list[dict]) -> None:
    """Power, detection thresholds and terrain loss over the common scenario clock."""
    import math

    image = Image.new("RGB", (1000, 680), "white")
    draw = ImageDraw.Draw(image)
    draw.text((80, 22), "RF trace: received power and modeled terrain attenuation", fill="#111827")
    if not frames:
        image.save(path)
        return
    palette = ["#2563eb", "#dc2626", "#15803d", "#9333ea", "#c2410c", "#0891b2", "#be185d", "#4d7c0f", "#4338ca", "#a16207", "#0f766e", "#475569"]
    colors = [palette[index % len(palette)] for index in range(len(sensors))]
    times = [frame["timestamp_s"] for frame in frames]
    first, span = min(times), max(max(times) - min(times), 1)
    all_readings = [reading for frame in frames for reading in frame["receivers"]]
    if not all_readings:
        draw.text((80, 75), "No RF receivers configured", fill="#374151")
        image.save(path)
        return
    min_power = math.floor(min(reading["power_dbm"] for reading in all_readings) / 10) * 10 - 5
    max_power = math.ceil(max(reading["power_dbm"] for reading in all_readings) / 10) * 10 + 5
    max_loss = max(10, math.ceil(max(reading["terrain_loss_db"] for reading in all_readings) / 10) * 10)
    for panel, field, minimum, maximum, title in [
        ((80, 75, 950, 285), "power_dbm", min_power, max_power, "Received power (dBm); dashed lines are detection thresholds"),
        ((80, 355, 950, 565), "terrain_loss_db", 0, max_loss, "Terrain attenuation (dB); higher means more signal lost"),
    ]:
        left, top, right, bottom = panel

        def screen(timestamp, value):
            return round(left + (timestamp - first) / span * (right - left)), round(bottom - (value - minimum) / (maximum - minimum) * (bottom - top))

        draw.text((left, top - 20), title, fill="#111827")
        draw.rectangle(panel, outline="#9ca3af")
        for fraction in [0, 0.25, 0.5, 0.75, 1]:
            value = minimum + fraction * (maximum - minimum)
            y = screen(first, value)[1]
            draw.line((left, y, right, y), fill="#e5e7eb")
            draw.text((22, y - 4), f"{value:.0f}", fill="#374151")
        for tick in range(math.ceil(first / 10) * 10, math.floor(max(times)) + 1, 10):
            x = screen(tick, minimum)[0]
            draw.line((x, top, x, bottom), fill="#e5e7eb")
            draw.text((x - 4, bottom + 8), str(tick), fill="#374151")
        for sensor, color in zip(sensors, colors):
            readings = [(frame["timestamp_s"], next(reading for reading in frame["receivers"] if reading["sensor_id"] == sensor["id"])) for frame in frames]
            draw.line([screen(timestamp, reading[field]) for timestamp, reading in readings], fill=color, width=2)
            if field == "power_dbm":
                threshold = sensor["noise_floor_dbm"] + sensor["detection_snr_db"]
                y = screen(first, threshold)[1]
                for x in range(left, right, 12):
                    draw.line((x, y, min(x + 6, right), y), fill=color)
                for timestamp, reading in readings:
                    if not reading["detected"]:
                        x, y = screen(timestamp, reading[field])
                        draw.line((x - 3, y - 3, x + 3, y + 3), fill=color)
                        draw.line((x - 3, y + 3, x + 3, y - 3), fill=color)
    draw.text((420, 600), "Scenario time (s)", fill="#374151")
    for index, sensor in enumerate(sensors):
        draw.text((80 + index * 70, 625), sensor["id"], fill=colors[index])
    draw.text((80, 650), "Cross marks: missed detections", fill="#374151")
    image.save(path)
