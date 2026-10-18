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
    for index, (label, color) in enumerate((
        ("Truth", "#15803d"), ("Raw intersection", "#f59e0b"),
        ("Filtered estimate", "#1d4ed8"), ("RF sites", "#111827"),
    )):
        draw.rectangle((margin + index * 195, height - 65, margin + 13 + index * 195, height - 52), fill=color)
        draw.text((margin + 19 + index * 195, height - 65), label, fill="#111827")
    image.save(path)
