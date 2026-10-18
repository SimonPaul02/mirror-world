import {
  Cartesian3, Cartographic, Color, EllipsoidGeodesic, Material,
  PointPrimitiveCollection, PolylineCollection,
  type PointPrimitive, type Polyline, type Viewer,
} from 'cesium';
import type { Fix } from './signals';

const GREEN = Color.fromCssColorString('#39e58c');
const YELLOW = Color.fromCssColorString('#ffd45a');
const RED = Color.fromCssColorString('#ff525e');

/** Fixed metre thresholds keep colors comparable across runs and receiver sites. */
export function errorColor(errorM: number): Color {
  if (errorM <= 100) return GREEN.clone();
  if (errorM < 500) return Color.lerp(GREEN, YELLOW, (errorM - 100) / 400, new Color());
  return Color.lerp(YELLOW, RED, Math.min(1, (errorM - 500) / 500), new Color());
}

export function horizontalErrorM(estimate: Cartographic, truth: Cartographic): number {
  return new EllipsoidGeodesic(estimate, truth).surfaceDistance;
}

interface TrailFrame {
  point?: PointPrimitive;
  segment?: Polyline;
  errorM?: number;
  count: number;
  sumSquaredError: number;
}

/** Precomputed RF fixes, revealed only through the current replay timestamp. */
export class EstimateTrail {
  private readonly points = new PointPrimitiveCollection();
  private readonly lines = new PolylineCollection();
  private readonly frames: TrailFrame[] = [];
  private visibleIndex = -1;

  constructor(
    private readonly viewer: Viewer,
    frames: Array<{ fix?: Fix }>,
    truth: Array<{ lon: number; lat: number }>,
  ) {
    viewer.scene.primitives.add(this.lines);
    viewer.scene.primitives.add(this.points);
    let count = 0, sumSquaredError = 0;
    let previous: Cartesian3 | undefined;
    for (const [index, frame] of frames.entries()) {
      const actual = truth[index]!;
      const entry: TrailFrame = { count, sumSquaredError };
      if (frame.fix) {
        const fix = frame.fix;
        const errorM = horizontalErrorM(Cartographic.fromDegrees(fix.lon, fix.lat), Cartographic.fromDegrees(actual.lon, actual.lat));
        const color = errorColor(errorM);
        const position = Cartesian3.fromDegrees(fix.lon, fix.lat, fix.haeM);
        entry.point = this.points.add({
          position, color, pixelSize: 6, outlineColor: Color.BLACK.withAlpha(.5), outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY, show: false,
        });
        if (previous) entry.segment = this.lines.add({
          positions: [previous, position], width: 3,
          material: Material.fromType('Color', { color: color.withAlpha(.85) }), show: false,
        });
        previous = position;
        entry.errorM = errorM;
        entry.count = ++count;
        sumSquaredError += errorM ** 2;
        entry.sumSquaredError = sumSquaredError;
      } else {
        // A gap means no RF fix; do not invent a connecting estimate.
        previous = undefined;
      }
      this.frames.push(entry);
    }
  }

  showThrough(index: number) {
    const end = Math.max(-1, Math.min(index, this.frames.length - 1));
    const lower = Math.min(this.visibleIndex, end) + 1;
    const upper = Math.max(this.visibleIndex, end);
    for (let i = lower; i <= upper; i++) {
      const frame = this.frames[i]!;
      if (frame.point) frame.point.show = i <= end;
      if (frame.segment) frame.segment.show = i <= end;
    }
    this.visibleIndex = end;
    const frame = this.frames[end];
    return {
      count: frame?.count ?? 0,
      currentErrorM: frame?.errorM,
      rmseM: frame?.count ? Math.sqrt(frame.sumSquaredError / frame.count) : undefined,
    };
  }

  destroy() {
    this.viewer.scene.primitives.remove(this.lines);
    this.viewer.scene.primitives.remove(this.points);
  }
}
